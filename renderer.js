const { ipcRenderer } = require('electron');

// Logger utility để gửi ERROR về main process
function logErrorToMain(...args) {
    try {
        ipcRenderer.send('renderer-log', 'ERROR', ...args);
    } catch (err) {
        // Nếu IPC không hoạt động, chỉ log ra console
        console.error('Failed to send log to main:', err);
    }
}

// Lưu console gốc
const originalConsoleError = console.error;

// Override console.error - Chỉ gửi ERROR về main process
console.error = function(...args) {
    originalConsoleError.apply(console, args);
    logErrorToMain(...args);
};

let combinedRecorder;
let audioChunks = [];
let startTime;
let recording = false;
let audioContext;
let destination;

// Lắng nghe lệnh từ main process
ipcRenderer.on('start-recording', async () => {
    await startRecording();
});

ipcRenderer.on('stop-recording', async () => {
    await stopRecording();
});

async function startRecording() {
    if (recording) {
        return;
    }
    
    recording = true;
    audioChunks = [];
    startTime = Date.now();
    
    try {
        // Tạo AudioContext để mix audio
        audioContext = new AudioContext();
        
        destination = audioContext.createMediaStreamDestination();
        
        let micConnected = false;
        let systemConnected = false;
        
        // 1. Kết nối Microphone
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000
                }
            });
            
            const micSource = audioContext.createMediaStreamSource(micStream);
            const micGain = audioContext.createGain();
            micGain.gain.value = 1.2;
            
            micSource.connect(micGain);
            micGain.connect(destination);
            
            micConnected = true;
        } catch (err) {
            console.error('Microphone error:', err);
        }
        
        // 2. Connect System Audio
        try {
            const sources = await ipcRenderer.invoke('get-sources');
            
            const entireScreen = sources.find(source => 
                source.name.toLowerCase().includes('entire') || 
                source.name.toLowerCase().includes('screen') ||
                source.id.includes('screen')
            );
            
            if (entireScreen) {
                const systemStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: entireScreen.id
                        }
                    },
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: entireScreen.id,
                            maxWidth: 1,
                            maxHeight: 1
                        }
                    }
                });
                
                const audioTracks = systemStream.getAudioTracks();
                
                if (audioTracks.length > 0) {
                    const systemAudioStream = new MediaStream([audioTracks[0]]);
                    const systemSource = audioContext.createMediaStreamSource(systemAudioStream);
                    
                    const systemGain = audioContext.createGain();
                    systemGain.gain.value = 1.0;
                    
                    systemSource.connect(systemGain);
                    systemGain.connect(destination);
                    
                    systemConnected = true;
                }
            }
        } catch (err) {
            console.error('System audio error:', err);
        }
        
        // 3. Kiểm tra nguồn âm thanh
        if (!micConnected && !systemConnected) {
            console.error('No audio sources available!');
            recording = false;
            return;
        }
        
        // 4. Bắt đầu ghi âm
        const combinedStream = destination.stream;
        
        // Kiểm tra MediaRecorder support
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];
        
        let selectedMimeType = null;
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                break;
            }
        }
        
        if (!selectedMimeType) {
            console.error('No supported MIME type found!');
            recording = false;
            return;
        }
        
        combinedRecorder = new MediaRecorder(combinedStream, {
            mimeType: selectedMimeType,
            audioBitsPerSecond: 128000
        });
        
        combinedRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        combinedRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
        };
        
        combinedRecorder.start(1000);
        
    } catch (err) {
        console.error('startRecording: Critical error:', err);
        recording = false;
    }
}

async function stopRecording() {
    if (!recording) {
        return;
    }
    
    recording = false;
    
    // Đợi MediaRecorder hoàn tất việc ghi và flush tất cả data chunks
    await new Promise((resolve, reject) => {
        if (!combinedRecorder) {
            resolve();
            return;
        }
        
        // Nếu recorder đã inactive, không cần đợi
        if (combinedRecorder.state === 'inactive') {
            resolve();
            return;
        }
        
        // Lắng nghe event onstop để đảm bảo tất cả data đã được flush
        const timeout = setTimeout(() => {
            console.error('stopRecording: Timeout waiting for MediaRecorder to stop');
            resolve(); // Vẫn resolve để không block
        }, 5000); // Timeout 5 giây
        
        combinedRecorder.onstop = () => {
            clearTimeout(timeout);
            resolve();
        };
        
        // Dừng recorder - sẽ trigger event onstop khi hoàn tất
        try {
            combinedRecorder.stop();
        } catch (err) {
            clearTimeout(timeout);
            console.error('stopRecording: Error stopping recorder:', err);
            resolve(); // Vẫn resolve để không block
        }
        
        // Dừng các audio tracks
        const stream = combinedRecorder.stream;
        if (stream) {
            const tracks = stream.getTracks();
            tracks.forEach((track) => {
                track.stop();
            });
        }
    });
    
    // Đợi thêm một chút để đảm bảo tất cả data chunks đã được push vào audioChunks
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Đóng AudioContext
    if (audioContext) {
        if (audioContext.state !== 'closed') {
            await audioContext.close();
        }
    }
    
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;
    const filename = `zalo_call_${timestamp}.mp3`;
    
    // Lưu file
    if (audioChunks.length > 0) {
        try {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            
            if (audioBlob.size === 0) {
                console.error('Blob is empty!');
                throw new Error('Blob is empty');
            }
            
            const audioData = await blobToDataURL(audioBlob);
            
            const result = await ipcRenderer.invoke('save-file', {
                filename: filename,
                dataUrl: audioData
            });
            
            const timeParams = {
                beginTime: startTime,
                endTime: Date.now()
            };
            
            // Upload file to server
            await ipcRenderer.invoke('upload-file', {
                timeParams,
                filePath: result.path
            });
        } catch (err) {
            console.error('stopRecording: Error saving file:', err.name, err.message);
        }
    } else {
        console.error('stopRecording: No audio data available!');
    }
    
    // Reset
    audioChunks = [];
    combinedRecorder = null;
    audioContext = null;
    destination = null;
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
