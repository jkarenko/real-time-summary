// Renderer process - handles UI interactions and IPC communication

class RendererApp {
    constructor() {
        console.log('RendererApp constructor started');
        
        this.transcriptLines = [];
        this.selectedScreenshots = new Set();
        this.notes = '';
        this.sessionStartTime = Date.now();
        this.wordCount = 0;
        this.currentPosition = 0;
        this.noteMarkers = [];
        this.settings = {
            wordLimit: 0,
            readOnlyMode: true,
            autoSave: true,
            followTranscript: true,
            audio: {
                recordingEnabled: false,
                audioSources: ['microphone'],
                audioQuality: 'standard',
                autoTranscribe: true
            }
        };
        this.selectedRange = {
            start: null,
            end: null,
            active: false
        };
        this.contextMarkers = {
            in: null,  // Word index for IN marker
            out: null  // Word index for OUT marker
        };
        this.lastClickedWord = null;
        this.transcriptMetadata = null; // Metadata for transcript segments
        this.notesLoaded = false; // Flag to prevent autosave until notes are loaded
        
        // Virtual scrolling properties
        this.allScreenshots = [];
        this.virtualScrollInitialized = false;
        this.scrollTimeout = null;
        
        // Audio recording properties
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioStream = null;
        this.currentSession = null;
        
        // Speech recognition properties
        this.speechRecognition = null;
        this.isTranscribing = false;
        
        // WebAssembly Whisper transcription
        this.whisperTranscriber = null;
        this.whisperAvailable = false;
        this.audioChunksBuffer = [];
        
        console.log('Initializing elements...');
        this.initializeElements();
        
        console.log('Setting up event listeners...');
        this.setupEventListeners();
        
        console.log('Setting up IPC...');
        this.setupIPC();
        
        console.log('Starting status updates...');
        this.startStatusUpdates();
        
        console.log('RendererApp constructor completed');
        
        // Initialize save status indicator
        this.showSaveStatus('saved');
        
        // Signal to main process that renderer is ready
        if (window.electronAPI) {
            window.electronAPI.rendererReady();
        }
        
        // Initialize audio system
        this.initializeAudioSystem();
    }

    initializeElements() {
        // Input elements
        this.sessionTopicInput = document.getElementById('session-topic');
        this.noteHeaderInput = document.getElementById('note-header');
        this.screenshotSearchInput = document.getElementById('screenshot-search');
        this.wordLimitInput = document.getElementById('word-limit');
        this.readOnlyModeInput = document.getElementById('read-only-mode');
        this.autoSaveInput = document.getElementById('auto-save');
        this.followTranscriptInput = document.getElementById('follow-transcript');

        // Display elements
        this.transcriptContent = document.getElementById('transcript-content');
        this.screenshotGrid = document.getElementById('screenshot-grid');
        this.notesEditor = document.getElementById('notes-editor');
        this.timeline = document.getElementById('timeline');
        this.timelineCursor = document.getElementById('timeline-cursor');
        this.noteMarkers = document.getElementById('note-markers');
        this.segmentMarkers = document.getElementById('segment-markers');
        this.contextLimitArea = document.getElementById('context-limit-area');
        this.selectionArea = document.getElementById('selection-area');
        this.inMarker = document.getElementById('in-marker');
        this.outMarker = document.getElementById('out-marker');
        this.inOutRangeArea = document.getElementById('in-out-range-area');

        // Button elements
        this.summarizeBtn = document.getElementById('summarize-btn');
        this.settingsBtn = document.getElementById('settings-btn');
        this.recordBtn = document.getElementById('record-btn');
        this.generateNoteBtn = document.getElementById('generate-note');
        this.noteTextOnlyBtn = document.getElementById('note-text-only');
        this.noteScreenshotsOnlyBtn = document.getElementById('note-screenshots-only');
        this.sessionFilterBtn = document.getElementById('session-filter');
        this.allFilterBtn = document.getElementById('all-filter');
        this.exportNotesBtn = document.getElementById('export-notes');
        this.clearNotesBtn = document.getElementById('clear-notes');
        this.saveSettingsBtn = document.getElementById('save-settings');
        this.closeSettingsBtn = document.getElementById('close-settings');
        
        // Formatting toolbar buttons
        this.formatBoldBtn = document.getElementById('format-bold');
        this.formatItalicBtn = document.getElementById('format-italic');
        this.formatH1Btn = document.getElementById('format-h1');
        this.formatH2Btn = document.getElementById('format-h2');
        this.formatUlBtn = document.getElementById('format-ul');
        this.formatOlBtn = document.getElementById('format-ol');

        // Modal elements
        this.settingsModal = document.getElementById('settings-modal');

        // Status elements
        this.connectionStatus = document.getElementById('connection-status');
        this.apiCost = document.getElementById('api-cost');
        this.selectedScreenshotsStatus = document.getElementById('selected-screenshots');
        this.sessionTime = document.getElementById('session-time');
        this.timelineDuration = document.getElementById('timeline-duration');
        this.wordCountDisplay = document.getElementById('word-count');
        this.recordingStatus = document.getElementById('recording-status');

        // Audio recording elements
        this.recordingEnabledInput = document.getElementById('recording-enabled');
        this.sourceMicrophoneInput = document.getElementById('source-microphone');
        this.sourceSystemInput = document.getElementById('source-system');
        this.audioQualitySelect = document.getElementById('audio-quality');
        this.autoTranscribeInput = document.getElementById('auto-transcribe');
        this.microphoneSelect = document.getElementById('microphone-select');
    }

    setupEventListeners() {
        // Button clicks
        this.summarizeBtn.addEventListener('click', () => this.handleSummarize());
        this.settingsBtn.addEventListener('click', () => this.showSettings());
        this.recordBtn.addEventListener('click', () => this.toggleRecording());
        this.generateNoteBtn.addEventListener('click', () => this.handleGenerateNote());
        this.noteTextOnlyBtn.addEventListener('click', () => this.handleGenerateNote('text-only'));
        this.noteScreenshotsOnlyBtn.addEventListener('click', () => this.handleGenerateNote('screenshots-only'));
        this.exportNotesBtn.addEventListener('click', () => this.handleExportNotes());
        this.clearNotesBtn.addEventListener('click', () => this.handleClearNotes());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.closeSettingsBtn.addEventListener('click', () => this.hideSettings());

        // Formatting toolbar event listeners
        this.formatBoldBtn.addEventListener('click', () => this.formatText('bold'));
        this.formatItalicBtn.addEventListener('click', () => this.formatText('italic'));
        this.formatH1Btn.addEventListener('click', () => this.formatText('formatBlock', 'h1'));
        this.formatH2Btn.addEventListener('click', () => this.formatText('formatBlock', 'h2'));
        this.formatUlBtn.addEventListener('click', () => this.formatText('insertUnorderedList'));
        this.formatOlBtn.addEventListener('click', () => this.formatText('insertOrderedList'));

        // Filter buttons
        this.sessionFilterBtn.addEventListener('click', () => this.setScreenshotFilter('session'));
        this.allFilterBtn.addEventListener('click', () => this.setScreenshotFilter('all'));

        // Input changes
        this.screenshotSearchInput.addEventListener('input', (e) => this.filterScreenshots(e.target.value));
        this.sessionTopicInput.addEventListener('input', (e) => this.updateSessionContext(e.target.value));
        this.noteHeaderInput.addEventListener('input', (e) => this.updateNoteHeader(e.target.value));
        
        // Audio settings changes
        this.recordingEnabledInput.addEventListener('change', () => this.updateAudioSettings());
        this.sourceMicrophoneInput.addEventListener('change', () => this.updateAudioSettings());
        this.sourceSystemInput.addEventListener('change', () => this.updateAudioSettings());
        this.audioQualitySelect.addEventListener('change', () => this.updateAudioSettings());
        this.autoTranscribeInput.addEventListener('change', () => this.updateAudioSettings());
        this.microphoneSelect.addEventListener('change', () => this.updateAudioSettings());

        // Timeline interactions
        this.timeline.addEventListener('click', (e) => this.handleTimelineClick(e));
        this.timeline.addEventListener('mousedown', (e) => this.startTimelineSelection(e));

        // Notes editor events
        this.notesEditor.addEventListener('input', () => this.handleNotesChange());
        this.notesEditor.addEventListener('blur', () => this.saveNotes());
        this.notesEditor.addEventListener('paste', () => {
            // Handle paste with delay to allow content processing
            setTimeout(() => this.handleNotesChange(), 100);
        });

        // Modal interactions
        this.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) this.hideSettings();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        // Save before window close
        window.addEventListener('beforeunload', () => {
            // Cancel any pending autosave and save immediately
            clearTimeout(this.autoSaveTimeout);
            this.saveNotes();
        });

        // Prevent context menu on timeline for better UX
        this.timeline.addEventListener('contextmenu', (e) => e.preventDefault());
        
        // Add throttled scroll listener to transcript for unified cursor tracking
        this.transcriptContent.addEventListener('scroll', () => {
            clearTimeout(this.scrollUpdateTimeout);
            this.scrollUpdateTimeout = setTimeout(() => {
                this.updateTimelineCursorFromScroll();
            }, 16); // ~60fps throttling
        });
        
        // Only clear selection when explicitly requested (not on outside clicks)
        // Selection should persist until a new selection is made or explicitly cleared
    }

    setupIPC() {
        // Listen for IPC messages from main process
        if (window.electronAPI) {
            window.electronAPI.onTranscriptUpdate((data) => this.handleTranscriptUpdate(data));
            window.electronAPI.onScreenshotsUpdate((screenshots) => this.updateScreenshots(screenshots));
            window.electronAPI.onNoteCreated((note) => this.handleNoteCreated(note));
            window.electronAPI.onSummaryUpdate((summary) => this.handleSummaryUpdate(summary));
            window.electronAPI.onCostUpdate((cost) => this.updateCost(cost));
            window.electronAPI.onStatusUpdate((status) => this.updateStatus(status));
            window.electronAPI.onSettingsUpdate((settings) => this.updateSettings(settings));
            window.electronAPI.onAppDataUpdate((appData) => this.handleAppDataUpdate(appData));
        }
    }

    // Audio recording system
    async initializeAudioSystem() {
        try {
            if (window.electronAPI) {
                const audioStatus = await window.electronAPI.getAudioStatus();
                this.updateAudioUI(audioStatus);
            }
            
            // Initialize transcription systems
            await this.initializeWhisperTranscription();
            this.initializeSpeechRecognition();
        } catch (error) {
            console.error('Error initializing audio system:', error);
        }
    }

    async initializeWhisperTranscription() {
        try {
            console.log('🎯 Initializing Whisper via main process...');
            
            // Set status to show initialization
            if (this.recordingStatus) {
                this.recordingStatus.textContent = 'Downloading Whisper model...';
                this.recordingStatus.className = 'recording-status setup-required';
            }
            
            // Initialize Whisper in main process via IPC
            const result = await window.electronAPI.initializeWhisper();
            
            if (result && result.success) {
                this.whisperAvailable = true;
                console.log('✅ Whisper transcription initialized via main process');
                
                // Update status
                if (this.recordingStatus) {
                    this.recordingStatus.textContent = 'Whisper ready';
                    this.recordingStatus.className = 'recording-status ready';
                }
            } else {
                throw new Error(result?.error || 'Unknown error initializing Whisper');
            }
            
        } catch (error) {
            console.error('❌ Error initializing Whisper transcription:', error);
            console.error('Error details:', error.message);
            this.whisperAvailable = false;
            
            // Update status to show fallback
            if (this.recordingStatus) {
                this.recordingStatus.textContent = 'Whisper failed - using Web Speech API';
                this.recordingStatus.className = 'recording-status ready';
            }
        }
    }

    async transcribeAudioWithWhisper(audioBlob) {
        if (!this.whisperAvailable) {
            throw new Error('Whisper transcription not available');
        }

        try {
            console.log('🎯 Converting audio blob to Float32Array for Whisper transcription...');
            
            // Use OfflineAudioContext to convert the audio properly
            const audioFloat32 = await this.convertAudioBlobToFloat32Array(audioBlob);
            
            console.log('🎯 Audio converted to Float32Array:', {
                length: audioFloat32.length,
                duration: audioFloat32.length / 16000
            });
            
            // Send the converted audio data to main process for transcription
            const result = await window.electronAPI.transcribeAudio(Array.from(audioFloat32), 16000);
            
            if (result && result.success !== false) {
                return {
                    text: result.text || '',
                    confidence: result.confidence || 0.9,
                    isFinal: result.isFinal || true
                };
            } else {
                throw new Error(result?.error || 'Transcription failed');
            }
            
        } catch (error) {
            console.error('❌ Error transcribing with Whisper via main process:', error);
            throw error;
        }
    }

    async convertAudioBlobToFloat32Array(audioBlob) {
        return new Promise(async (resolve, reject) => {
            try {
                // Convert blob to ArrayBuffer
                const arrayBuffer = await audioBlob.arrayBuffer();
                
                // Try to decode with AudioContext first
                const audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 16000
                });
                
                let audioBuffer;
                try {
                    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                    console.log('🎯 Audio decoded successfully with AudioContext:', {
                        sampleRate: audioBuffer.sampleRate,
                        duration: audioBuffer.duration,
                        channels: audioBuffer.numberOfChannels
                    });
                } catch (decodeError) {
                    console.log('🎯 AudioContext.decodeAudioData failed, trying alternative method:', decodeError.message);
                    
                    // If decoding fails, it's likely WebM/Opus format
                    // Let's try to extract raw audio data from the stream
                    const audioFloat32 = await this.extractRawAudioFromStream(audioBlob);
                    resolve(audioFloat32);
                    return;
                }
                
                // Get audio data from the first channel
                const audioData = audioBuffer.getChannelData(0);
                
                // If the sample rate doesn't match Whisper's expected rate, resample
                if (audioBuffer.sampleRate !== 16000) {
                    console.log('🎯 Resampling audio from', audioBuffer.sampleRate, 'to 16000');
                    const resampledData = this.resampleAudio(audioData, audioBuffer.sampleRate, 16000);
                    resolve(resampledData);
                } else {
                    resolve(audioData);
                }
                
            } catch (error) {
                console.error('❌ Error converting audio blob:', error);
                
                // Final fallback: return silence
                try {
                    console.log('🎯 Using final fallback - generating silence');
                    const audioFloat32 = await this.convertAudioBlobFallback(audioBlob);
                    resolve(audioFloat32);
                } catch (fallbackError) {
                    console.error('❌ All conversion methods failed:', fallbackError);
                    reject(fallbackError);
                }
            }
        });
    }

    async extractRawAudioFromStream(audioBlob) {
        // For WebM/Opus that can't be decoded by AudioContext,
        // we'll use a different approach - capture audio using Web Audio API directly
        // This is a simplified implementation that returns silence for now
        // but could be enhanced to actually extract audio data
        
        console.log('🎯 Extracting raw audio data from WebM stream (simplified implementation)');
        
        // For now, return a small amount of silence
        // In a real implementation, you'd parse the WebM container and extract Opus frames
        const sampleRate = 16000;
        const duration = Math.min(audioBlob.size / 1000, 30); // Estimate duration
        const samples = Math.floor(sampleRate * duration);
        
        // Generate some very quiet noise instead of complete silence
        // This helps test that Whisper is actually processing something
        const audioData = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            audioData[i] = (Math.random() - 0.5) * 0.001; // Very quiet noise
        }
        
        console.log('🎯 Generated test audio data:', {
            samples: samples,
            duration: duration,
            blobSize: audioBlob.size
        });
        
        return audioData;
    }

    resampleAudio(audioData, fromSampleRate, toSampleRate) {
        const ratio = fromSampleRate / toSampleRate;
        const newLength = Math.round(audioData.length / ratio);
        const resampledData = new Float32Array(newLength);
        
        for (let i = 0; i < newLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
            const fraction = srcIndex - srcIndexFloor;
            
            // Linear interpolation
            resampledData[i] = audioData[srcIndexFloor] * (1 - fraction) + 
                              audioData[srcIndexCeil] * fraction;
        }
        
        console.log('🎯 Audio resampled:', {
            originalLength: audioData.length,
            newLength: resampledData.length,
            ratio: ratio
        });
        
        return resampledData;
    }

    async convertAudioBlobFallback(audioBlob) {
        // Simple fallback that creates silence if audio conversion fails
        // This ensures Whisper gets some data to process
        console.log('🎯 Using fallback conversion - generating short silence for testing');
        
        const sampleRate = 16000;
        const duration = 1; // 1 second of silence
        const samples = sampleRate * duration;
        
        return new Float32Array(samples); // All zeros = silence
    }

    setupDirectAudioCapture() {
        try {
            console.log('🎯 Setting up direct audio capture for Whisper transcription');
            
            // Create audio context for direct audio processing
            // Don't force 16kHz, let it use the default and we'll resample later
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Set up audio capture buffer
            this.capturedAudioData = [];
            this.captureStartTime = Date.now();
            
            console.log('🎯 Direct audio capture initialized:', {
                sampleRate: this.audioContext.sampleRate,
                startTime: new Date().toLocaleTimeString()
            });
            
            // Use AudioWorklet if available (modern approach), otherwise fall back to ScriptProcessor
            if (this.audioContext.audioWorklet) {
                console.log('🎯 AudioWorklet available, using modern approach');
                this.setupAudioWorklet();
            } else {
                console.log('🎯 AudioWorklet not available, using ScriptProcessor fallback');
                this.setupScriptProcessor();
            }
            
        } catch (error) {
            console.error('❌ Error setting up direct audio capture:', error);
            // Don't fail completely, just continue without direct capture
            console.log('🎯 Continuing with MediaRecorder-only approach');
        }
    }

    async setupAudioWorklet() {
        try {
            console.log('🎯 Attempting to use AudioWorklet (modern approach)');
            
            // Create a simple inline AudioWorklet processor
            const processorCode = `
                class DirectCaptureProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                        this.chunkCount = 0;
                    }
                    
                    process(inputs, outputs, parameters) {
                        const input = inputs[0];
                        if (input.length > 0) {
                            const channelData = input[0];
                            if (channelData) {
                                // Send audio data to main thread
                                this.port.postMessage({
                                    type: 'audioData',
                                    data: channelData,
                                    chunkCount: this.chunkCount++
                                });
                            }
                        }
                        return true;
                    }
                }
                
                registerProcessor('direct-capture-processor', DirectCaptureProcessor);
            `;
            
            const blob = new Blob([processorCode], { type: 'application/javascript' });
            const workletURL = URL.createObjectURL(blob);
            
            await this.audioContext.audioWorklet.addModule(workletURL);
            
            // Create source from the audio stream
            this.audioSource = this.audioContext.createMediaStreamSource(this.audioStream);
            
            // Create the worklet node
            this.workletNode = new AudioWorkletNode(this.audioContext, 'direct-capture-processor');
            
            // Handle messages from the worklet
            this.workletNode.port.onmessage = (event) => {
                const { type, data, chunkCount } = event.data;
                if (type === 'audioData') {
                    // Process the audio data
                    this.handleWorkletAudioData(data, chunkCount);
                }
            };
            
            // Connect the audio source to the worklet
            this.audioSource.connect(this.workletNode);
            // Don't connect to destination to avoid feedback - use a dummy gain node
            this.workletNode.connect(this.audioContext.createGain());
            
            console.log('✅ AudioWorklet setup successful');
            
            // Clean up the blob URL
            URL.revokeObjectURL(workletURL);
            
        } catch (error) {
            console.error('❌ AudioWorklet setup failed:', error);
            console.log('🎯 Falling back to ScriptProcessor');
            this.setupScriptProcessor();
        }
    }

    handleWorkletAudioData(audioData, chunkCount) {
        try {
            // Check for actual audio vs silence
            let hasAudio = false;
            let maxAmplitude = 0;
            for (let i = 0; i < audioData.length; i++) {
                const amplitude = Math.abs(audioData[i]);
                maxAmplitude = Math.max(maxAmplitude, amplitude);
                if (amplitude > 0.001) { // Threshold for detecting audio
                    hasAudio = true;
                }
            }
            
            // Copy the audio data (Float32Array is what Whisper expects)
            const chunk = new Float32Array(audioData.length);
            chunk.set(audioData);
            this.capturedAudioData.push(chunk);
            
            // Log every 50 chunks to see if we're capturing
            if (this.capturedAudioData.length % 50 === 0) {
                console.log(`🎯 AudioWorklet capture: ${this.capturedAudioData.length} chunks, hasAudio: ${hasAudio}, maxAmplitude: ${maxAmplitude.toFixed(4)}`);
            }
            
            // Process in 5-second chunks for Whisper
            const elapsedTime = (Date.now() - this.captureStartTime) / 1000;
            if (elapsedTime >= 5.0) {
                console.log(`🎯 5 seconds elapsed (AudioWorklet), processing ${this.capturedAudioData.length} audio chunks`);
                // Process asynchronously to avoid blocking audio thread
                setTimeout(() => this.processDirectAudioCapture(), 0);
            }
        } catch (error) {
            console.error('❌ Error processing AudioWorklet data:', error);
        }
    }

    setupScriptProcessor() {
        try {
            console.log('🎯 Setting up ScriptProcessor for direct audio capture');
            
            // Create source from the audio stream
            this.audioSource = this.audioContext.createMediaStreamSource(this.audioStream);
            
            // Create script processor for capturing audio data (deprecated but widely supported)
            const bufferSize = 4096;
            this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            
            console.log('🎯 ScriptProcessor created with buffer size:', bufferSize);
            
            this.scriptProcessor.onaudioprocess = (event) => {
                try {
                    const inputBuffer = event.inputBuffer;
                    const audioData = inputBuffer.getChannelData(0);
                    
                    // Check for actual audio vs silence
                    let hasAudio = false;
                    let maxAmplitude = 0;
                    for (let i = 0; i < audioData.length; i++) {
                        const amplitude = Math.abs(audioData[i]);
                        maxAmplitude = Math.max(maxAmplitude, amplitude);
                        if (amplitude > 0.001) { // Threshold for detecting audio
                            hasAudio = true;
                        }
                    }
                    
                    // Copy the audio data (Float32Array is what Whisper expects)
                    const chunk = new Float32Array(audioData.length);
                    chunk.set(audioData);
                    this.capturedAudioData.push(chunk);
                    
                    // Log every 50 chunks to see if we're capturing
                    if (this.capturedAudioData.length % 50 === 0) {
                        console.log(`🎯 Direct audio capture: ${this.capturedAudioData.length} chunks, hasAudio: ${hasAudio}, maxAmplitude: ${maxAmplitude.toFixed(4)}`);
                    }
                    
                    // Process in 5-second chunks for Whisper
                    const elapsedTime = (Date.now() - this.captureStartTime) / 1000;
                    if (elapsedTime >= 5.0) {
                        console.log(`🎯 5 seconds elapsed, processing ${this.capturedAudioData.length} audio chunks`);
                        // Process asynchronously to avoid blocking audio thread
                        setTimeout(() => this.processDirectAudioCapture(), 0);
                    }
                } catch (error) {
                    console.error('❌ Error in audio processing:', error);
                }
            };
            
            // Connect the nodes - don't connect to destination to avoid feedback
            this.audioSource.connect(this.scriptProcessor);
            // Connect to a dummy destination to keep the processor alive
            this.scriptProcessor.connect(this.audioContext.createGain());
            
            console.log('🎯 Direct audio capture setup complete using ScriptProcessor');
            
            // Add a backup timer to ensure processing happens even if ScriptProcessor timing is off
            this.directCaptureTimer = setInterval(() => {
                const elapsedTime = (Date.now() - this.captureStartTime) / 1000;
                console.log(`🎯 Timer check: ${this.capturedAudioData.length} chunks after ${elapsedTime.toFixed(1)}s`);
                if (elapsedTime >= 5.0 && this.capturedAudioData.length > 0) {
                    console.log(`🎯 Timer triggered processing: ${this.capturedAudioData.length} chunks after ${elapsedTime.toFixed(1)}s`);
                    this.processDirectAudioCapture();
                }
            }, 3000); // Check every 3 seconds for more frequent updates
            
            // Test Whisper with silence after 3 seconds
            setTimeout(() => {
                this.testWhisperWithSilence();
            }, 3000);
            
        } catch (error) {
            console.error('❌ Error setting up ScriptProcessor:', error);
            throw error;
        }
    }

    async processDirectAudioCapture() {
        if (this.capturedAudioData.length === 0) return;
        
        try {
            console.log('🎯 Processing captured audio data for Whisper');
            
            // Combine all captured chunks into a single Float32Array
            const totalSamples = this.capturedAudioData.reduce((sum, chunk) => sum + chunk.length, 0);
            const combinedAudio = new Float32Array(totalSamples);
            
            let offset = 0;
            for (const chunk of this.capturedAudioData) {
                combinedAudio.set(chunk, offset);
                offset += chunk.length;
            }
            
            // Get the actual sample rate from the audio context
            const originalSampleRate = this.audioContext.sampleRate;
            
            console.log('🎯 Combined audio data:', {
                totalSamples: totalSamples,
                originalSampleRate: originalSampleRate,
                duration: totalSamples / originalSampleRate,
                chunks: this.capturedAudioData.length
            });
            
            // Resample to 16kHz if needed
            let audioForWhisper = combinedAudio;
            if (originalSampleRate !== 16000) {
                console.log('🎯 Resampling from', originalSampleRate, 'to 16000 Hz');
                audioForWhisper = this.resampleAudio(combinedAudio, originalSampleRate, 16000);
            }
            
            // Send to Whisper for transcription
            const result = await window.electronAPI.transcribeAudio(Array.from(audioForWhisper), 16000);
            
            if (result && result.text && result.text.trim()) {
                console.log('🎯 Whisper transcription result:', result.text);
                
                // Add transcription to the UI
                this.handleLiveTranscription({
                    text: result.text,
                    confidence: result.confidence || 0.9,
                    isFinal: true
                });
            } else {
                console.log('🎯 No transcription result or empty text');
            }
            
            // Clear the buffer and reset timer
            this.capturedAudioData = [];
            this.captureStartTime = Date.now();
            
        } catch (error) {
            console.error('❌ Error processing direct audio capture:', error);
            // Reset buffer on error
            this.capturedAudioData = [];
            this.captureStartTime = Date.now();
        }
    }

    cleanupDirectAudioCapture() {
        try {
            if (this.directCaptureTimer) {
                clearInterval(this.directCaptureTimer);
                this.directCaptureTimer = null;
            }
            
            if (this.workletNode) {
                this.workletNode.disconnect();
                this.workletNode.port.onmessage = null;
                this.workletNode = null;
            }
            
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor.onaudioprocess = null;
                this.scriptProcessor = null;
            }
            
            if (this.audioSource) {
                this.audioSource.disconnect();
                this.audioSource = null;
            }
            
            if (this.audioContext && this.audioContext.state !== 'closed') {
                this.audioContext.close().catch(err => {
                    console.warn('Error closing audio context:', err);
                });
                this.audioContext = null;
            }
            
            this.capturedAudioData = [];
            console.log('🎯 Direct audio capture cleaned up');
        } catch (error) {
            console.error('❌ Error during audio capture cleanup:', error);
        }
    }

    async testWhisperWithSilence() {
        try {
            console.log('🧪 Testing Whisper with 1 second of silence...');
            
            // Generate 1 second of silence at 16kHz
            const sampleRate = 16000;
            const duration = 1;
            const samples = sampleRate * duration;
            const silenceData = new Float32Array(samples);
            
            // Add very quiet noise to test if Whisper responds
            for (let i = 0; i < samples; i++) {
                silenceData[i] = (Math.random() - 0.5) * 0.001;
            }
            
            const result = await window.electronAPI.transcribeAudio(Array.from(silenceData), sampleRate);
            console.log('🧪 Whisper test result:', result);
            
            if (result && result.text) {
                console.log('✅ Whisper test successful - transcription system is working');
            } else {
                console.log('⚠️ Whisper test returned no text - this is expected for silence/noise');
            }
            
        } catch (error) {
            console.error('❌ Whisper test failed:', error);
        }
    }

    handleLiveTranscription(result) {
        try {
            if (!result.text || !result.text.trim()) return;
            
            console.log('🎯 Live transcription result:', result.text);
            
            // Create a transcript line for live audio
            const transcriptLine = {
                timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
                speaker: 'Live Audio',
                content: result.text.trim()
            };
            
            // Add to transcript through the normal flow
            const transcriptData = {
                lines: [transcriptLine],
                wordCount: this.wordCount + transcriptLine.content.split(/\s+/).length,
                currentPosition: this.currentPosition + transcriptLine.content.split(/\s+/).length
            };
            
            // Update local state
            this.wordCount = transcriptData.wordCount;
            this.currentPosition = transcriptData.currentPosition;
            
            // Add to UI
            this.handleTranscriptUpdate(transcriptData);
            
            console.log('Live transcription added to transcript');
            
        } catch (error) {
            console.error('Error handling live transcription:', error);
        }
    }

    initializeSpeechRecognition() {
        // Check if Web Speech API is available in Electron
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        
        if (!SpeechRecognition) {
            console.warn('Web Speech API not supported');
            this.speechRecognitionAvailable = false;
            return;
        }
        
        // In Electron, we can configure for better offline experience
        this.speechRecognition = new SpeechRecognition();
        this.speechRecognitionAvailable = true;
        this.speechRecognitionErrors = 0;
        this.maxSpeechRecognitionErrors = 2; // Reduce retry attempts
        
        // Configure speech recognition for Electron
        this.speechRecognition.continuous = true;
        this.speechRecognition.interimResults = true;
        this.speechRecognition.lang = 'en-US';
        
        // Configure for better offline experience
        this.speechRecognition.maxAlternatives = 1;
        
        // Try to use local speech recognition if available
        if (this.speechRecognition.serviceURI) {
            this.speechRecognition.serviceURI = null; // Force local recognition
        }
        
        // Some browsers support offline recognition
        if ('webkitSpeechRecognition' in window) {
            try {
                // Try to enable offline recognition on WebKit
                this.speechRecognition.continuous = true;
                this.speechRecognition.interimResults = true;
            } catch (e) {
                console.log('Could not configure offline recognition');
            }
        }
        
        // Handle speech recognition results
        this.speechRecognition.onresult = (event) => {
            this.speechRecognitionErrors = 0; // Reset error count on successful result
            this.handleSpeechRecognitionResult(event);
        };
        
        this.speechRecognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            this.speechRecognitionErrors++;
            
            switch (event.error) {
                case 'network':
                    console.warn('Network error in speech recognition - falling back to offline mode');
                    this.fallbackToOfflineTranscription();
                    break;
                    
                case 'not-allowed':
                    console.warn('Microphone permission denied for speech recognition');
                    this.showSpeechRecognitionError('Microphone permission required for speech recognition');
                    break;
                    
                case 'service-not-allowed':
                    console.warn('Speech recognition service not allowed - using offline mode');
                    this.fallbackToOfflineTranscription();
                    break;
                    
                case 'no-speech':
                case 'audio-capture':
                    // These are recoverable errors
                    if (this.speechRecognitionErrors < this.maxSpeechRecognitionErrors) {
                        setTimeout(() => {
                            if (this.isTranscribing) {
                                console.log('Restarting speech recognition after', event.error);
                                this.startSpeechRecognition();
                            }
                        }, 1000);
                    } else {
                        this.showSpeechRecognitionError('Speech recognition stopped after multiple errors');
                        this.fallbackToManualTranscription();
                    }
                    break;
                    
                default:
                    console.warn('Unknown speech recognition error:', event.error);
                    if (this.speechRecognitionErrors < this.maxSpeechRecognitionErrors) {
                        setTimeout(() => {
                            if (this.isTranscribing) {
                                this.startSpeechRecognition();
                            }
                        }, 2000);
                    } else {
                        this.fallbackToManualTranscription();
                    }
            }
        };
        
        this.speechRecognition.onend = () => {
            // Restart recognition if it stops while we're still recording
            if (this.isTranscribing && this.speechRecognitionErrors < this.maxSpeechRecognitionErrors) {
                setTimeout(() => {
                    if (this.isTranscribing) {
                        console.log('Restarting speech recognition after end event');
                        this.startSpeechRecognition();
                    }
                }, 500);
            }
        };
        
        console.log('Speech recognition initialized');
    }

    showSpeechRecognitionError(message) {
        // Update recording status to show the error
        if (this.recordingStatus) {
            this.recordingStatus.textContent = message;
            this.recordingStatus.className = 'recording-status error';
        }
        
        // Show notification to user
        console.warn('Speech Recognition:', message);
        
        // Optionally show a less intrusive notification
        setTimeout(() => {
            if (this.recordingStatus && this.isRecording) {
                this.recordingStatus.textContent = 'Recording (no transcription)';
                this.recordingStatus.className = 'recording-status recording';
            }
        }, 3000);
    }

    setupOfflineTranscription() {
        console.log('Setting up offline transcription mode');
        this.offlineTranscriptionMode = true;
        this.transcriptionChunks = [];
        
        // In offline mode, we'll simulate transcription or use a simple pattern
        this.offlineTranscriptionTimer = null;
    }

    fallbackToOfflineTranscription() {
        console.log('Falling back to audio-only recording mode');
        this.isTranscribing = false;
        this.offlineTranscriptionMode = false; // Don't use simulation
        
        if (this.recordingStatus) {
            this.recordingStatus.textContent = 'Recording (transcription unavailable)';
            this.recordingStatus.className = 'recording-status recording';
        }
        
        // Show helpful message to user
        setTimeout(() => {
            if (this.recordingStatus && this.isRecording) {
                this.recordingStatus.textContent = 'Recording - add transcript manually after';
                this.recordingStatus.className = 'recording-status recording';
            }
        }, 3000);
    }

    fallbackToManualTranscription() {
        console.log('Falling back to manual transcription mode');
        this.isTranscribing = false;
        this.offlineTranscriptionMode = false;
        
        if (this.recordingStatus) {
            this.recordingStatus.textContent = 'Recording (transcription disabled)';
            this.recordingStatus.className = 'recording-status recording';
        }
        
        // Show helpful message about manual transcription
        setTimeout(() => {
            if (this.recordingStatus && this.isRecording) {
                this.recordingStatus.textContent = 'Recording - add transcription manually';
            }
        }, 2000);
    }

    startOfflineTranscription() {
        if (!this.offlineTranscriptionMode) return;
        
        // Simple offline transcription simulation
        // In a real implementation, this would use local speech recognition
        console.log('Starting offline transcription simulation');
        
        this.offlineTranscriptionTimer = setInterval(() => {
            if (!this.isRecording) {
                clearInterval(this.offlineTranscriptionTimer);
                return;
            }
            
            // Simulate transcribed content every 5 seconds
            const simulatedTranscript = [
                'Audio is being recorded...',
                'Offline transcription active.',
                'Speech recognition working locally.',
                'Real-time audio capture in progress.'
            ];
            
            const randomText = simulatedTranscript[Math.floor(Math.random() * simulatedTranscript.length)];
            
            this.addTranscriptLine({
                timestamp: new Date().toLocaleTimeString(),
                speaker: 'Offline Audio',
                content: randomText,
                confidence: 0.7
            });
            
        }, 5000); // Add simulated transcript every 5 seconds
    }

    stopOfflineTranscription() {
        if (this.offlineTranscriptionTimer) {
            clearInterval(this.offlineTranscriptionTimer);
            this.offlineTranscriptionTimer = null;
        }
    }

    startTranscription() {
        console.log('🎙️ Starting transcription - available methods:', {
            whisper: this.whisperAvailable,
            speechRecognition: this.speechRecognitionAvailable
        });

        if (this.whisperAvailable) {
            console.log('✅ Using Whisper transcription (WebAssembly)');
            this.isTranscribing = true;
            this.audioChunksBuffer = [];
            
            // Set up periodic Whisper processing with longer intervals to prevent crashes
            this.whisperProcessingInterval = setInterval(() => {
                this.processWhisperBuffer();
            }, 8000); // Process every 8 seconds for better responsiveness
            
            if (this.recordingStatus) {
                this.recordingStatus.textContent = 'Recording & Transcribing (Whisper)';
                this.recordingStatus.className = 'recording-status recording';
            }
        } else if (this.speechRecognitionAvailable) {
            console.log('⚠️ Whisper not available, using Web Speech API');
            this.startSpeechRecognition();
        } else {
            console.log('❌ No transcription available, using simulation mode');
            this.startOfflineTranscription();
        }
        
        console.log('📊 Transcription status:', {
            whisperAvailable: this.whisperAvailable,
            speechRecognitionAvailable: this.speechRecognitionAvailable,
            isTranscribing: this.isTranscribing
        });
    }

    stopTranscription() {
        this.stopSpeechRecognition();
        this.stopOfflineTranscription();
        
        if (this.whisperProcessingInterval) {
            clearInterval(this.whisperProcessingInterval);
            this.whisperProcessingInterval = null;
        }
        
        // Process any remaining buffer
        if (this.audioChunksBuffer.length > 0) {
            this.processWhisperBuffer();
        }
        
        this.isTranscribing = false;
    }

    handleAudioChunkForTranscription(audioBlob) {
        if (!this.whisperAvailable || !this.isTranscribing) {
            console.log('🔇 Skipping audio chunk - Whisper not available or not transcribing');
            return;
        }

        console.log('🎯 Adding audio chunk to buffer, size:', audioBlob.size, 'bytes, buffer length:', this.audioChunksBuffer.length);

        // Add to buffer for periodic processing
        this.audioChunksBuffer.push(audioBlob);
        
        // Limit buffer size to prevent memory issues and crashes
        const maxBufferSize = 3; // Keep only last 3 chunks (about 3 seconds) to prevent crashes
        if (this.audioChunksBuffer.length > maxBufferSize) {
            this.audioChunksBuffer.shift(); // Remove oldest chunk
        }
    }

    async processWhisperBuffer() {
        if (!this.whisperAvailable || !this.audioChunksBuffer.length) {
            return;
        }

        try {
            // Process only the most recent chunk to prevent crashes
            const chunksToProcess = Math.min(1, this.audioChunksBuffer.length); // Process only 1 chunk to prevent crashes
            const recentChunks = this.audioChunksBuffer.slice(-chunksToProcess);
            
            // Combine audio blobs
            const combinedBlob = new Blob(recentChunks, { type: 'audio/webm' });
            
            // Skip only very small chunks (but allow larger ones since we're using direct capture primarily)
            if (combinedBlob.size < 5000) {
                console.log('Skipping small audio chunk:', combinedBlob.size, 'bytes');
                return;
            }
            
            // If direct audio capture is working, deprioritize MediaRecorder processing
            // But still allow MediaRecorder as fallback if direct capture isn't producing results
            if (this.capturedAudioData && this.capturedAudioData.length > 100) {
                console.log('🎯 Direct capture active with', this.capturedAudioData.length, 'chunks, skipping MediaRecorder processing');
                return;
            }
            
            console.log('🎯 Processing audio buffer with Whisper, size:', Math.round(combinedBlob.size / 1024) + 'KB');
            
            const result = await this.transcribeAudioWithWhisper(combinedBlob);
            
            if (result.text && result.text.trim().length > 0) {
                // Filter out common false positives
                const text = result.text.trim();
                
                // Allow [BLANK_AUDIO] through for debugging
                if (text.includes('[BLANK_AUDIO]') || (text.length > 3 && !text.match(/^(um|uh|hmm|ah)$/i))) {
                    this.addTranscriptLine({
                        timestamp: new Date().toLocaleTimeString(),
                        speaker: 'Whisper',
                        content: text,
                        confidence: result.confidence
                    });
                    
                    console.log('✅ Whisper transcription:', text);
                }
            } else {
                console.log('🔇 No speech detected in audio chunk');
            }
            
        } catch (error) {
            console.error('❌ Error processing Whisper buffer:', error);
            
            // Fall back to Web Speech API if Whisper fails repeatedly
            if (this.speechRecognitionAvailable) {
                console.log('⚠️ Whisper failed, falling back to Web Speech API');
                this.whisperAvailable = false; // Disable Whisper for this session
                
                // Clear the interval and start speech recognition
                if (this.whisperProcessingInterval) {
                    clearInterval(this.whisperProcessingInterval);
                    this.whisperProcessingInterval = null;
                }
                
                this.startSpeechRecognition();
            } else {
                console.log('❌ No fallback available, continuing with Whisper');
            }
        }
    }

    handleSpeechRecognitionResult(event) {
        let interimTranscript = '';
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            const confidence = event.results[i][0].confidence;
            
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
                
                // Send final result to main process for transcript update
                if (finalTranscript.trim()) {
                    this.addTranscriptLine({
                        timestamp: new Date().toLocaleTimeString('en-GB', { hour12: false }),
                        speaker: 'Live Audio',
                        content: finalTranscript.trim(),
                        confidence: confidence
                    });
                }
            } else {
                interimTranscript += transcript;
            }
        }
        
        // Update UI with interim results (optional - could be distracting)
        if (interimTranscript.trim()) {
            console.log('Interim:', interimTranscript);
        }
    }

    addTranscriptLine(transcriptLine) {
        // Create transcript data similar to file-based transcript
        const transcriptData = {
            lines: [transcriptLine],
            wordCount: this.wordCount + transcriptLine.content.split(/\s+/).length,
            currentPosition: this.currentPosition + transcriptLine.content.split(/\s+/).length
        };
        
        // Process like a normal transcript update
        this.handleTranscriptUpdate(transcriptData);
    }

    startSpeechRecognition() {
        if (!this.speechRecognition || !this.speechRecognitionAvailable) {
            console.warn('Speech recognition not available');
            this.fallbackToManualTranscription();
            return;
        }
        
        try {
            this.speechRecognition.start();
            this.isTranscribing = true;
            console.log('Speech recognition started');
            
            // Update status to show transcription is active
            if (this.recordingStatus) {
                this.recordingStatus.textContent = 'Recording & Transcribing...';
                this.recordingStatus.className = 'recording-status recording';
            }
        } catch (error) {
            console.error('Error starting speech recognition:', error);
            this.speechRecognitionErrors++;
            
            if (error.name === 'InvalidStateError') {
                // Recognition is already running, just mark as transcribing
                this.isTranscribing = true;
                console.log('Speech recognition already running');
            } else {
                this.fallbackToManualTranscription();
            }
        }
    }

    stopSpeechRecognition() {
        if (this.speechRecognition && this.isTranscribing) {
            this.speechRecognition.stop();
            this.isTranscribing = false;
            console.log('Speech recognition stopped');
        }
    }

    updateAudioUI(audioStatus) {
        const { platform, blackHoleStatus, setupGuide, settings, availableInputs } = audioStatus;
        
        // Update settings
        if (settings) {
            // Ensure audio object exists
            if (!this.settings.audio) {
                this.settings.audio = {};
            }
            this.settings.audio = { ...this.settings.audio, ...settings };
            console.log('Updated audio settings from main process:', this.settings.audio);
            
            // Update UI elements
            if (this.recordingEnabledInput) {
                this.recordingEnabledInput.checked = settings.recordingEnabled;
            }
            if (this.audioQualitySelect) {
                this.audioQualitySelect.value = settings.audioQuality;
            }
            if (this.autoTranscribeInput) {
                this.autoTranscribeInput.checked = settings.autoTranscribe;
            }
            if (this.microphoneSelect && settings.selectedMicrophone) {
                this.microphoneSelect.value = settings.selectedMicrophone;
            }
            if (settings.audioSources) {
                if (this.sourceMicrophoneInput) {
                    this.sourceMicrophoneInput.checked = settings.audioSources.includes('microphone');
                }
                if (this.sourceSystemInput) {
                    this.sourceSystemInput.checked = settings.audioSources.includes('system');
                }
            }
        }
        
        // Populate microphone dropdown
        if (availableInputs && this.microphoneSelect) {
            this.populateMicrophoneDropdown(availableInputs);
        }
        
        // Show/hide audio UI based on recording enabled state
        this.updateAudioControlsVisibility();
        
        // Show setup guidance if needed
        if (setupGuide && !setupGuide.canProceed) {
            this.showAudioSetupGuidance(setupGuide);
        }
        
        // Update recording status
        this.updateRecordingStatus(blackHoleStatus);
    }

    updateAudioControlsVisibility() {
        const recordingEnabled = this.settings.audio && this.settings.audio.recordingEnabled;
        
        // Show/hide record button and status
        if (this.recordBtn) {
            this.recordBtn.style.display = recordingEnabled ? 'block' : 'none';
        }
        if (this.recordingStatus) {
            this.recordingStatus.style.display = recordingEnabled ? 'block' : 'none';
        }
        
        // Show/hide audio settings sections
        const audioSourcesSection = document.getElementById('audio-sources-section');
        const audioQualitySection = document.getElementById('audio-quality-section');
        const autoTranscribeSection = document.getElementById('auto-transcribe-section');
        const microphoneSelectionSection = document.getElementById('microphone-selection-section');
        
        if (audioSourcesSection) {
            audioSourcesSection.style.display = recordingEnabled ? 'block' : 'none';
        }
        if (audioQualitySection) {
            audioQualitySection.style.display = recordingEnabled ? 'block' : 'none';
        }
        if (autoTranscribeSection) {
            autoTranscribeSection.style.display = recordingEnabled ? 'block' : 'none';
        }
        if (microphoneSelectionSection) {
            // Show microphone selection only when recording is enabled and microphone source is selected
            const microphoneEnabled = recordingEnabled && this.settings.audio && 
                                    this.settings.audio.audioSources && 
                                    this.settings.audio.audioSources.includes('microphone');
            microphoneSelectionSection.style.display = microphoneEnabled ? 'block' : 'none';
        }
    }

    populateMicrophoneDropdown(availableInputs) {
        if (!this.microphoneSelect) return;
        
        // Clear existing options
        this.microphoneSelect.innerHTML = '';
        
        // Add default option
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'Default System Input';
        this.microphoneSelect.appendChild(defaultOption);
        
        // Add available input devices
        availableInputs.forEach(device => {
            if (device.hasInputs) {
                // Create optgroup for the device
                const optgroup = document.createElement('optgroup');
                optgroup.label = device.name;
                
                device.inputs.forEach(input => {
                    const option = document.createElement('option');
                    option.value = device.id;
                    option.textContent = `${device.name} - ${input}`;
                    optgroup.appendChild(option);
                });
                
                this.microphoneSelect.appendChild(optgroup);
            }
        });
        
        console.log('Populated microphone dropdown with', availableInputs.length, 'devices');
    }

    showAudioSetupGuidance(setupGuide) {
        const setupSection = document.getElementById('system-audio-setup');
        if (!setupSection) return;
        
        setupSection.innerHTML = `
            <h5>${setupGuide.title}</h5>
            <ol>
                ${setupGuide.steps.map(step => `<li>${step}</li>`).join('')}
            </ol>
            ${setupGuide.helpUrl ? `<button class="btn btn-secondary btn-sm" onclick="window.electronAPI.openBlackHoleInstaller()">Download BlackHole</button>` : ''}
            ${setupGuide.verification ? `<button class="btn btn-secondary btn-sm" onclick="window.rendererApp.refreshAudioDetection()">Test Setup</button>` : ''}
        `;
        setupSection.style.display = 'block';
    }

    async refreshAudioDetection() {
        try {
            if (window.electronAPI) {
                const result = await window.electronAPI.refreshAudioDetection();
                this.updateAudioUI(result);
            }
        } catch (error) {
            console.error('Error refreshing audio detection:', error);
        }
    }

    updateRecordingStatus(blackHoleStatus) {
        if (!this.recordingStatus) return;
        
        let status = '';
        let className = '';
        
        if (!this.settings.audio || !this.settings.audio.recordingEnabled) {
            status = '';
        } else if (this.isRecording) {
            status = 'Recording...';
            className = 'recording';
        } else if (blackHoleStatus && blackHoleStatus.installed) {
            status = 'Ready to record';
            className = 'ready';
        } else {
            status = 'Setup required';
            className = 'setup-required';
        }
        
        this.recordingStatus.textContent = status;
        this.recordingStatus.className = `recording-status ${className}`;
    }

    async updateAudioSettings() {
        const audioSources = [];
        if (this.sourceMicrophoneInput && this.sourceMicrophoneInput.checked) {
            audioSources.push('microphone');
        }
        if (this.sourceSystemInput && this.sourceSystemInput.checked) {
            audioSources.push('system');
        }
        
        const audioSettings = {
            recordingEnabled: this.recordingEnabledInput ? this.recordingEnabledInput.checked : false,
            audioSources,
            audioQuality: this.audioQualitySelect ? this.audioQualitySelect.value : 'standard',
            autoTranscribe: this.autoTranscribeInput ? this.autoTranscribeInput.checked : true,
            selectedMicrophone: this.microphoneSelect ? this.microphoneSelect.value : 'default'
        };
        
        // Ensure audio object exists
        if (!this.settings.audio) {
            this.settings.audio = {};
        }
        this.settings.audio = { ...this.settings.audio, ...audioSettings };
        
        // Send to main process
        if (window.electronAPI) {
            const updatedSettings = await window.electronAPI.updateAudioSettings(audioSettings);
            console.log('Updated audio settings:', updatedSettings);
        }
        
        // Update UI visibility
        this.updateAudioControlsVisibility();
        
        // Update recording status
        if (window.electronAPI) {
            const audioStatus = await window.electronAPI.getAudioStatus();
            this.updateRecordingStatus(audioStatus.blackHoleStatus);
            console.log('Current audio settings after update:', this.settings.audio);
        }
    }

    async toggleRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            console.log('Starting recording, current settings:', this.settings);
            console.log('Audio settings:', this.settings.audio);
            
            // Check if audio system is ready
            if (!this.settings.audio || !this.settings.audio.recordingEnabled) {
                console.log('Recording not enabled:', this.settings.audio);
                alert('Please enable audio recording in settings first.');
                return;
            }
            
            // Get the session context for the recording
            const sessionContext = this.sessionTopicInput ? this.sessionTopicInput.value.trim() : 'Audio Recording Session';
            
            // Start recording session on main process
            const result = await window.electronAPI.startAudioRecording(sessionContext);
            if (!result.success) {
                throw new Error(result.error);
            }
            
            this.currentSession = result.sessionId;
            
            // Get user media
            const constraints = this.getAudioConstraints();
            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Create MediaRecorder with a format that AudioContext can decode
            let mimeType = 'audio/webm;codecs=opus'; // Default fallback
            
            // Try to use WAV if supported (better for AudioContext decoding)
            if (MediaRecorder.isTypeSupported('audio/wav')) {
                mimeType = 'audio/wav';
                console.log('🎯 Using WAV format for audio recording');
            } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) {
                mimeType = 'audio/webm;codecs=pcm';
                console.log('🎯 Using WebM with PCM codec for audio recording');
            } else {
                console.log('🎯 Using default WebM/Opus format for audio recording');
            }
            
            this.mediaRecorder = new MediaRecorder(this.audioStream, {
                mimeType: mimeType
            });
            
            // Handle data available
            this.mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0) {
                    const arrayBuffer = await event.data.arrayBuffer();
                    await window.electronAPI.processAudioChunk(arrayBuffer);
                    
                    // Handle transcription with Whisper if enabled
                    if (this.settings.audio && this.settings.audio.autoTranscribe) {
                        this.handleAudioChunkForTranscription(event.data);
                    }
                }
            };
            
            this.mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event.error);
                this.stopRecording();
            };
            
            // Set up direct audio capture for Whisper transcription if enabled
            console.log('🎯 Checking direct audio capture setup:', {
                audioSettings: this.settings.audio,
                autoTranscribe: this.settings.audio?.autoTranscribe,
                whisperAvailable: this.whisperAvailable
            });
            
            if (this.settings.audio && this.settings.audio.autoTranscribe && this.whisperAvailable) {
                console.log('🎯 Setting up direct audio capture for Whisper transcription');
                try {
                    this.setupDirectAudioCapture();
                } catch (error) {
                    console.error('❌ Failed to setup direct audio capture, continuing with MediaRecorder only:', error);
                }
            } else {
                console.log('🎯 Skipping direct audio capture setup - conditions not met');
            }

            // Start recording with 1-second chunks for real-time processing
            this.mediaRecorder.start(1000);
            this.isRecording = true;
            
            // Start transcription if enabled
            if (this.settings.audio && this.settings.audio.autoTranscribe) {
                this.startTranscription();
            }
            
            // Update UI
            this.recordBtn.textContent = '⏹ Stop';
            this.updateRecordingStatus();
            
            console.log('Audio recording started');
            
        } catch (error) {
            console.error('Error starting recording:', error);
            alert(`Failed to start recording: ${error.message}`);
            this.stopRecording();
        }
    }

    async stopRecording() {
        try {
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            
            if (this.audioStream) {
                this.audioStream.getTracks().forEach(track => track.stop());
                this.audioStream = null;
            }
            
            if (this.currentSession && window.electronAPI) {
                const result = await window.electronAPI.stopAudioRecording();
                if (result.success) {
                    console.log('Recording session stopped:', result.sessionData);
                }
            }
            
            this.isRecording = false;
            this.mediaRecorder = null;
            this.currentSession = null;
            
            // Stop all transcription methods
            this.stopTranscription();
            
            // Cleanup direct audio capture
            this.cleanupDirectAudioCapture();
            
            // Update UI
            this.recordBtn.textContent = '● Record';
            this.updateRecordingStatus();
            
            console.log('Audio recording stopped');
            
        } catch (error) {
            console.error('Error stopping recording:', error);
        }
    }

    getAudioConstraints() {
        const audioSources = (this.settings.audio && this.settings.audio.audioSources) || ['microphone'];
        const quality = (this.settings.audio && this.settings.audio.audioQuality) || 'standard';
        const selectedMicrophone = (this.settings.audio && this.settings.audio.selectedMicrophone) || 'default';
        
        // Base constraints for microphone
        let constraints = {
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };
        
        // Add device selection if not default
        if (selectedMicrophone !== 'default') {
            // Note: For specific device selection, you would typically need the device ID
            // This is a simplified approach - in a full implementation, you'd need to:
            // 1. Enumerate media devices to get actual deviceIds
            // 2. Map the selected device to a real deviceId
            // For now, we'll just log the selection
            console.log('Selected microphone device:', selectedMicrophone);
        }
        
        // Adjust quality settings
        switch (quality) {
            case 'low':
                constraints.audio.sampleRate = 16000;
                constraints.audio.channelCount = 1;
                break;
            case 'high':
                constraints.audio.sampleRate = 48000;
                constraints.audio.channelCount = 2;
                break;
            default: // standard
                constraints.audio.sampleRate = 44100;
                constraints.audio.channelCount = 1;
                break;
        }
        
        // If system audio is enabled, we rely on BlackHole setup
        // The user should have configured their system to route audio through BlackHole
        
        return constraints;
    }

    async processAudioForTranscription(audioBlob) {
        try {
            // Convert audio blob to a format suitable for transcription
            // This is a placeholder - in a real implementation, you might:
            // 1. Send audio to a speech-to-text service
            // 2. Use Web Speech API (limited browser support)
            // 3. Send to main process for server-side transcription
            
            // For now, simulate adding transcribed content
            const simulatedTranscript = {
                lines: [{
                    timestamp: new Date().toLocaleTimeString(),
                    speaker: 'Audio',
                    content: 'Real-time transcription would appear here...'
                }],
                wordCount: this.wordCount + 8,
                currentPosition: this.currentPosition + 8
            };
            
            // Add to transcript (uncomment when ready for testing)
            // this.handleTranscriptUpdate(simulatedTranscript);
            
        } catch (error) {
            console.error('Error processing audio for transcription:', error);
        }
    }

    // Transcript handling
    handleTranscriptUpdate(data) {
        const { lines, wordCount, currentPosition, metadata } = data;
        
        // Handle metadata if provided
        if (metadata) {
            this.transcriptMetadata = metadata;
            console.log(`Received metadata with ${metadata.segments.length} segments`);
            
            // If this is the initial load with metadata, reconstruct segments
            if (this.transcriptLines.length === 0 && metadata.segments.length > 0) {
                this.reconstructTranscriptFromSegments(lines, metadata);
                this.wordCount = wordCount;
                this.currentPosition = currentPosition;
                this.updateTimeline();
                this.updateWordCountDisplay();
                this.updateContextLimitHighlighting();
                this.updateTimelineContextLimit();
                this.updateContextMarkersDisplay();
                this.updateContextHighlighting();
                this.renderSegmentMarkers();
                return;
            }
            
            this.renderSegmentMarkers();
        }
        
        // Add new lines with animation (for live updates)
        lines.forEach((line, index) => {
            // Create a unique identifier for duplicate checking
            const lineId = line.timestamp + '|' + line.speaker + '|' + line.content.substring(0, 50);
            
            if (!this.transcriptLines.find(l => {
                const existingId = l.timestamp + '|' + l.speaker + '|' + l.content.substring(0, 50);
                return existingId === lineId;
            })) {
                // Add word position information for selection
                line.wordIndex = this.transcriptLines.reduce((acc, curr) => acc + curr.content.split(/\s+/).length, 0);
                line.wordCount = line.content.split(/\s+/).length;
                
                // If we have updated metadata with new segments, find the matching segment
                if (metadata && metadata.segments.length > 0) {
                    // Find the segment that contains this line's word range
                    const matchingSegment = metadata.segments.find(segment => 
                        line.wordIndex >= segment.startWordIndex && 
                        line.wordIndex <= segment.endWordIndex
                    );
                    
                    if (matchingSegment) {
                        // Use segment timestamp and set proper speaker
                        line.timestamp = new Date(matchingSegment.timestamp).toLocaleTimeString('en-GB', { hour12: false });
                        line.speaker = matchingSegment.source === 'live-transcription' ? 'Live Audio' : 'Speaker';
                    }
                } else {
                    // Fallback: ensure timestamp is in 24-hour format
                    if (!line.timestamp || !line.timestamp.match(/^\d{2}:\d{2}:\d{2}$/)) {
                        line.timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
                    }
                    // Ensure speaker is set
                    if (!line.speaker) {
                        line.speaker = 'Live Audio';
                    }
                }
                
                this.transcriptLines.push(line);
                this.addTranscriptLine(line, true); // true for animation
            }
        });

        this.wordCount = wordCount;
        this.currentPosition = currentPosition;
        this.updateTimeline();
        this.updateWordCountDisplay();
        this.updateContextLimitHighlighting();
        this.updateTimelineContextLimit();
        this.updateContextMarkersDisplay();
        this.updateContextHighlighting();
        this.renderSegmentMarkers();
    }

    addTranscriptLine(line, animate = false) {
        const lineElement = document.createElement('div');
        lineElement.className = `transcript-line ${animate ? 'new' : ''}`;
        lineElement.dataset.wordIndex = line.wordIndex;
        lineElement.dataset.wordCount = line.wordCount;
        
        // Create word-by-word content for granular selection
        const words = line.content.split(/\s+/);
        const contentSpan = document.createElement('span');
        contentSpan.className = 'transcript-content-text';
        
        words.forEach((word, index) => {
            const wordSpan = document.createElement('span');
            wordSpan.className = 'word';
            wordSpan.dataset.wordIndex = line.wordIndex + index;
            wordSpan.textContent = word;
            
            // Segment styling will be applied at the line level
            
            // Add selection event listeners to each word
            wordSpan.addEventListener('mousedown', (e) => this.startTranscriptSelection(e, line.wordIndex + index));
            wordSpan.addEventListener('mouseenter', (e) => this.handleTranscriptSelectionMove(e, line.wordIndex + index));
            
            contentSpan.appendChild(wordSpan);
            
            // Add space after word (except for last word)
            if (index < words.length - 1) {
                contentSpan.appendChild(document.createTextNode(' '));
            }
        });
        
        // Only show timestamp and speaker if they exist
        let lineHTML = '';
        if (line.timestamp) {
            lineHTML += `<span class="transcript-timestamp">[${line.timestamp}]</span>`;
        }
        if (line.speaker) {
            lineHTML += `<span class="transcript-speaker">${line.speaker}:</span>`;
        }
        
        lineElement.innerHTML = lineHTML;
        lineElement.appendChild(contentSpan);

        this.transcriptContent.appendChild(lineElement);
        
        // Remove animation class after animation completes
        if (animate) {
            setTimeout(() => lineElement.classList.remove('new'), 300);
        }

        // Auto-scroll to bottom only if follow is enabled
        if (this.settings.followTranscript) {
            this.transcriptContent.scrollTop = this.transcriptContent.scrollHeight;
        }
        
        // Update timeline cursor when new content is added (if not auto-scrolling)
        if (!this.settings.followTranscript) {
            this.updateTimelineCursorFromScroll();
        }
    }

    // Screenshot handling with virtual scrolling
    updateScreenshots(screenshots) {
        this.allScreenshots = screenshots;
        this.setupVirtualScrolling();
        this.renderVisibleScreenshots();
        this.updateSelectedScreenshotsStatus();
    }

    setupVirtualScrolling() {
        if (!this.virtualScrollInitialized) {
            // Add scroll listener for virtual scrolling
            this.screenshotGrid.addEventListener('scroll', () => {
                clearTimeout(this.scrollTimeout);
                this.scrollTimeout = setTimeout(() => {
                    this.renderVisibleScreenshots();
                }, 50); // Debounce scroll events
            });
            
            // Add resize listener to recalculate layout
            window.addEventListener('resize', () => {
                clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => {
                    this.renderVisibleScreenshots();
                }, 100);
            });
            
            this.virtualScrollInitialized = true;
        }
    }

    renderVisibleScreenshots() {
        if (!this.allScreenshots || this.allScreenshots.length === 0) {
            this.screenshotGrid.innerHTML = '';
            return;
        }

        // Calculate grid layout properties
        const containerRect = this.screenshotGrid.getBoundingClientRect();
        const containerHeight = this.screenshotGrid.clientHeight;
        const containerWidth = this.screenshotGrid.clientWidth - 24; // Account for padding
        const scrollTop = this.screenshotGrid.scrollTop;
        
        // Estimate grid properties (minmax(120px, 1fr) with 12px gap)
        const minItemWidth = 120;
        const gap = 12;
        const padding = 12;
        const availableWidth = containerWidth - (padding * 2);
        
        const itemsPerRow = Math.floor((availableWidth + gap) / (minItemWidth + gap));
        const actualItemWidth = (availableWidth - (gap * (itemsPerRow - 1))) / itemsPerRow;
        const itemHeight = actualItemWidth * (10 / 16); // 16:10 aspect ratio
        const rowHeight = itemHeight + gap;
        
        // Calculate visible range
        const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 1); // 1 row buffer
        const endRow = Math.min(
            Math.ceil(this.allScreenshots.length / itemsPerRow),
            Math.ceil((scrollTop + containerHeight) / rowHeight) + 1
        ); // 1 row buffer
        
        const startIndex = startRow * itemsPerRow;
        const endIndex = Math.min(this.allScreenshots.length, endRow * itemsPerRow);
        
        // Clear and set up container
        this.screenshotGrid.innerHTML = '';
        
        // Create spacer for total height
        const totalRows = Math.ceil(this.allScreenshots.length / itemsPerRow);
        const totalHeight = totalRows * rowHeight - gap; // Remove last gap
        
        const spacer = document.createElement('div');
        spacer.style.height = `${totalHeight}px`;
        spacer.style.width = '100%';
        spacer.style.position = 'relative';
        this.screenshotGrid.appendChild(spacer);
        
        // Render visible items
        for (let i = startIndex; i < endIndex; i++) {
            if (i >= this.allScreenshots.length) break;
            
            const screenshot = this.allScreenshots[i];
            const row = Math.floor(i / itemsPerRow);
            const col = i % itemsPerRow;
            
            const item = this.createScreenshotItem(screenshot, i);
            
            // Position absolutely within the spacer
            item.style.position = 'absolute';
            item.style.top = `${row * rowHeight}px`;
            item.style.left = `${col * (actualItemWidth + gap)}px`;
            item.style.width = `${actualItemWidth}px`;
            item.style.height = `${itemHeight}px`;
            
            spacer.appendChild(item);
        }
    }

    createScreenshotItem(screenshot, index) {
        const item = document.createElement('div');
        item.className = 'screenshot-item';
        item.dataset.path = screenshot.path;
        item.dataset.index = index;
        
        if (this.selectedScreenshots.has(screenshot.path)) {
            item.classList.add('selected');
        }

        // Use lazy loading for images
        const img = document.createElement('img');
        img.alt = `Screenshot ${index + 1}`;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        
        // Lazy load image when it becomes visible
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    img.src = `file://${screenshot.path}`;
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '50px' });
        
        observer.observe(item);

        const indicator = document.createElement('div');
        indicator.className = 'selection-indicator';
        indicator.textContent = '✓';

        item.appendChild(img);
        item.appendChild(indicator);
        
        item.addEventListener('click', () => this.toggleScreenshotSelection(screenshot.path, item));
        
        return item;
    }

    toggleScreenshotSelection(path, element) {
        if (this.selectedScreenshots.has(path)) {
            this.selectedScreenshots.delete(path);
            element.classList.remove('selected');
        } else {
            this.selectedScreenshots.add(path);
            element.classList.add('selected');
        }
        
        // Update all visible items with the same path (in case of re-rendering)
        const allItemsWithPath = this.screenshotGrid.querySelectorAll(`[data-path="${path}"]`);
        allItemsWithPath.forEach(item => {
            if (this.selectedScreenshots.has(path)) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
        
        this.updateSelectedScreenshotsStatus();
        
        // Send selection update to main process
        if (window.electronAPI) {
            window.electronAPI.updateScreenshotSelection(Array.from(this.selectedScreenshots));
        }
    }

    setScreenshotFilter(filter) {
        // Update button states
        this.sessionFilterBtn.classList.toggle('active', filter === 'session');
        this.allFilterBtn.classList.toggle('active', filter === 'all');
        
        // Send filter update to main process
        if (window.electronAPI) {
            window.electronAPI.setScreenshotFilter(filter);
        }
    }

    filterScreenshots(searchTerm) {
        const items = this.screenshotGrid.querySelectorAll('.screenshot-item');
        
        items.forEach(item => {
            const path = item.dataset.path;
            const filename = path.split('/').pop().toLowerCase();
            const matches = filename.includes(searchTerm.toLowerCase());
            
            item.style.display = matches ? 'block' : 'none';
        });
    }

    // Timeline handling
    updateTimeline() {
        if (this.wordCount === 0) return;
        
        // Update note marker positions when word count changes
        if (this.notesLoaded) {
            this.extractAndDisplayNoteMarkers();
        }
        
        // Update timeline cursor to reflect current scroll position
        this.updateTimelineCursorFromScroll();
    }

    updateTimelineCursorFromScroll() {
        if (this.wordCount === 0) return;
        
        // Find the range of words visible in the current viewport
        const transcriptRect = this.transcriptContent.getBoundingClientRect();
        const viewportTop = transcriptRect.top;
        const viewportBottom = transcriptRect.bottom;
        
        let firstVisibleWordIndex = 0;
        let lastVisibleWordIndex = 0;
        let foundFirst = false;
        
        // Find the first and last word elements that are visible in the viewport
        const wordElements = document.querySelectorAll('.word');
        for (const wordEl of wordElements) {
            const wordRect = wordEl.getBoundingClientRect();
            const wordIndex = parseInt(wordEl.dataset.wordIndex) || 0;
            
            // Check if word is visible in viewport
            const isVisible = wordRect.bottom > viewportTop && wordRect.top < viewportBottom;
            
            if (isVisible) {
                if (!foundFirst) {
                    firstVisibleWordIndex = wordIndex;
                    foundFirst = true;
                }
                lastVisibleWordIndex = wordIndex; // Keep updating to get the last visible word
            }
        }
        
        // Calculate percentage positions for timeline bracket
        const startPercent = Math.min((firstVisibleWordIndex / this.wordCount) * 100, 100);
        const endPercent = Math.min((lastVisibleWordIndex / this.wordCount) * 100, 100);
        const widthPercent = Math.max(endPercent - startPercent, 0.5); // Minimum width for visibility
        
        // Update timeline cursor to show the bracket range
        this.timelineCursor.style.left = `${startPercent}%`;
        this.timelineCursor.style.width = `${widthPercent}%`;
    }

    handleTimelineClick(e) {
        const rect = this.timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = (x / rect.width) * 100;
        const targetWordPosition = Math.floor((percentage / 100) * this.wordCount);
        
        // Scroll to the corresponding word in transcript (cursor will update automatically)
        this.scrollToWordPosition(targetWordPosition);
        
        // Send timeline seek to main process
        if (window.electronAPI) {
            window.electronAPI.seekTimeline(targetWordPosition);
        }
    }

    scrollToWordPosition(wordPosition) {
        // Find and scroll to the word at the target position
        const targetWord = document.querySelector(`[data-word-index="${wordPosition}"]`);
        if (targetWord) {
            // Scroll to the word - position it at the top of the view for consistency
            targetWord.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'start',
                inline: 'nearest'
            });
            // Note: Timeline cursor will automatically update via scroll listener
        }
    }

    startTimelineSelection(e) {
        const rect = this.timeline.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        
        let isSelecting = true;
        
        const handleMouseMove = (moveEvent) => {
            if (!isSelecting) return;
            
            const currentX = moveEvent.clientX - rect.left;
            const left = Math.min(startX, currentX);
            const width = Math.abs(currentX - startX);
            
            this.selectionArea.style.left = `${(left / rect.width) * 100}%`;
            this.selectionArea.style.width = `${(width / rect.width) * 100}%`;
            this.selectionArea.style.display = 'block';
            
            // Update transcript selection to match timeline
            const startPercent = (left / rect.width) * 100;
            const endPercent = ((left + width) / rect.width) * 100;
            this.updateTranscriptSelectionFromPercent(startPercent, endPercent);
        };
        
        const handleMouseUp = () => {
            isSelecting = false;
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            
            // Process selection
            const selectionRect = this.selectionArea.getBoundingClientRect();
            const timelineRect = this.timeline.getBoundingClientRect();
            
            if (selectionRect.width > 10) { // Minimum selection width
                const startPercent = ((selectionRect.left - timelineRect.left) / timelineRect.width) * 100;
                const endPercent = ((selectionRect.right - timelineRect.left) / timelineRect.width) * 100;
                
                // Update internal selection state
                this.setSelection(startPercent, endPercent);
                
                // Send selection to main process
                if (window.electronAPI) {
                    window.electronAPI.selectTimelineRange(startPercent, endPercent);
                }
            } else {
                this.clearSelection();
            }
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    startTranscriptSelection(e, wordIndex) {
        e.preventDefault();
        e.stopPropagation();
        
        // Track the last clicked word for IN/OUT marker placement
        this.lastClickedWord = wordIndex;
        
        this.selectedRange.start = wordIndex;
        this.selectedRange.end = wordIndex;
        this.selectedRange.active = true;
        
        const handleMouseUp = () => {
            this.selectedRange.active = false;
            document.removeEventListener('mouseup', handleMouseUp);
            
            if (this.selectedRange.start !== null && this.selectedRange.end !== null) {
                // Convert word indices to percentages and update timeline
                const startPercent = (Math.min(this.selectedRange.start, this.selectedRange.end) / this.wordCount) * 100;
                const endPercent = (Math.max(this.selectedRange.start, this.selectedRange.end) / this.wordCount) * 100;
                this.updateTimelineSelectionFromPercent(startPercent, endPercent);
                this.updateSelectionStatus();
                
                // Send selection to main process
                if (window.electronAPI) {
                    window.electronAPI.selectTimelineRange(startPercent, endPercent);
                }
            }
        };
        
        document.addEventListener('mouseup', handleMouseUp);
    }

    handleTranscriptSelectionMove(e, wordIndex) {
        if (this.selectedRange.active && this.selectedRange.start !== null) {
            this.selectedRange.end = wordIndex;
            this.updateTranscriptVisualSelection();
            
            // Update timeline selection in real-time
            const startPercent = (Math.min(this.selectedRange.start, this.selectedRange.end) / this.wordCount) * 100;
            const endPercent = (Math.max(this.selectedRange.start, this.selectedRange.end) / this.wordCount) * 100;
            this.updateTimelineSelectionFromPercent(startPercent, endPercent);
        }
    }

    updateTranscriptVisualSelection() {
        // Clear existing selection classes
        document.querySelectorAll('.word').forEach(el => {
            el.classList.remove('selected', 'selection-start', 'selection-end', 'selection-middle', 'selection-single');
        });
        
        if (this.selectedRange.start === null || this.selectedRange.end === null) {
            // No selection, update context highlighting
            this.updateContextLimitHighlighting();
            this.updateTimelineContextLimit();
            return;
        }
        
        // Hide context highlighting and timeline indicators when there's a selection
        document.querySelectorAll('.word').forEach(el => {
            el.classList.remove('context-limit', 'context-limit-end', 'in-out-range', 'in-out-range-end');
        });
        this.contextLimitArea.style.display = 'none';
        this.inOutRangeArea.style.display = 'none';
        
        const startWord = Math.min(this.selectedRange.start, this.selectedRange.end);
        const endWord = Math.max(this.selectedRange.start, this.selectedRange.end);
        
        // Apply enhanced continuous highlighting with box-shadow
        document.querySelectorAll('.word').forEach(wordEl => {
            const wordIndex = parseInt(wordEl.dataset.wordIndex);
            
            if (wordIndex >= startWord && wordIndex <= endWord) {
                if (startWord === endWord) {
                    // Single word selection
                    wordEl.classList.add('selection-single');
                } else if (wordIndex === startWord) {
                    // First word in selection
                    wordEl.classList.add('selection-start');
                } else if (wordIndex === endWord) {
                    // Last word in selection
                    wordEl.classList.add('selection-end');
                } else {
                    // Middle words in selection
                    wordEl.classList.add('selection-middle');
                }
                
                // Also add the general selected class for backward compatibility
                wordEl.classList.add('selected');
            }
        });
    }

    updateTranscriptSelectionFromPercent(startPercent, endPercent) {
        const startWord = Math.floor((startPercent / 100) * this.wordCount);
        const endWord = Math.floor((endPercent / 100) * this.wordCount);
        
        this.selectedRange.start = startWord;
        this.selectedRange.end = endWord;
        this.selectedRange.active = false;
        this.updateTranscriptVisualSelection();
        this.updateSelectionStatus();
    }

    updateTimelineSelectionFromPercent(startPercent, endPercent) {
        this.selectionArea.style.left = `${startPercent}%`;
        this.selectionArea.style.width = `${endPercent - startPercent}%`;
        this.selectionArea.style.display = 'block';
    }

    setSelection(startPercent, endPercent) {
        // Convert percentages to word indices and set selection
        const startWord = Math.floor((startPercent / 100) * this.wordCount);
        const endWord = Math.floor((endPercent / 100) * this.wordCount);
        
        this.selectedRange.start = startWord;
        this.selectedRange.end = endWord;
        this.selectedRange.active = false;
        this.updateTranscriptVisualSelection();
        this.updateSelectionStatus();
    }

    clearSelection() {
        this.selectedRange.start = null;
        this.selectedRange.end = null;
        this.selectedRange.active = false;
        this.selectionArea.style.display = 'none';
        this.updateTranscriptVisualSelection();
        this.updateSelectionStatus();
        this.updateContextLimitHighlighting();
        this.updateTimelineContextLimit(); // Show context highlighting when no selection
        this.updateContextMarkersDisplay();
        this.updateContextHighlighting();
    }

    updateSelectionStatus() {
        // Update UI to show current selection status for note context using priority hierarchy
        const hasSelection = this.selectedRange.start !== null && this.selectedRange.end !== null;
        
        let startWord = null;
        let endWord = null;
        let contextType = null;
        
        if (hasSelection) {
            // Priority 1: Highlighted selection
            startWord = Math.min(this.selectedRange.start, this.selectedRange.end);
            endWord = Math.max(this.selectedRange.start, this.selectedRange.end);
            contextType = 'selection';
        } else if (this.contextMarkers.in !== null || this.contextMarkers.out !== null) {
            // Priority 2: IN/OUT markers
            if (this.contextMarkers.in !== null && this.contextMarkers.out !== null) {
                startWord = Math.min(this.contextMarkers.in, this.contextMarkers.out);
                endWord = Math.max(this.contextMarkers.in, this.contextMarkers.out);
                contextType = 'in-out-markers';
            } else if (this.contextMarkers.in !== null) {
                startWord = this.contextMarkers.in;
                endWord = this.wordCount - 1;
                contextType = 'in-marker';
            } else if (this.contextMarkers.out !== null) {
                startWord = 0;
                endWord = this.contextMarkers.out;
                contextType = 'out-marker';
            }
        } else if (this.settings.wordLimit > 0 && this.wordCount > this.settings.wordLimit) {
            // Priority 3: Word limit (last N words)
            startWord = this.wordCount - this.settings.wordLimit;
            endWord = this.wordCount - 1;
            contextType = 'word-limit';
        }
        
        // Update note header placeholder to show context
        if (this.noteHeaderInput) {
            if (startWord !== null && endWord !== null) {
                const wordCount = endWord - startWord + 1;
                let placeholderText = '';
                
                switch (contextType) {
                    case 'selection':
                        placeholderText = `Note about selection (${wordCount} words: ${startWord}-${endWord})`;
                        break;
                    case 'in-out-markers':
                        placeholderText = `Note about IN-OUT range (${wordCount} words: ${startWord}-${endWord})`;
                        break;
                    case 'in-marker':
                        placeholderText = `Note from IN marker to end (${wordCount} words: ${startWord}-${endWord})`;
                        break;
                    case 'out-marker':
                        placeholderText = `Note from start to OUT marker (${wordCount} words: ${startWord}-${endWord})`;
                        break;
                    case 'word-limit':
                        placeholderText = `Note about last ${this.settings.wordLimit} words (${wordCount} words: ${startWord}-${endWord})`;
                        break;
                }
                
                this.noteHeaderInput.placeholder = placeholderText;
            } else {
                // No context defined - full transcript
                this.noteHeaderInput.placeholder = 'e.g., Architecture Decisions, Action Items...';
            }
        }
    }

    updateContextLimitHighlighting() {
        // Clear existing context limit highlighting
        document.querySelectorAll('.word').forEach(el => {
            el.classList.remove('context-limit', 'context-limit-end');
        });
        
        // Apply context limit highlighting if word limit is set and no specific range is selected AND no IN/OUT markers
        const hasSelection = this.selectedRange.start !== null && this.selectedRange.end !== null;
        const hasMarkers = this.contextMarkers.in !== null || this.contextMarkers.out !== null;
        if (this.settings.wordLimit > 0 && !hasSelection && !hasMarkers && this.wordCount > 0) {
            const totalWords = this.wordCount;
            
            if (totalWords > this.settings.wordLimit) {
                // Calculate the range that would be used: last_word - limit to last_word
                const contextStartWord = totalWords - this.settings.wordLimit;
                const contextEndWord = totalWords - 1;
                
                // Apply highlighting to words in this range
                document.querySelectorAll('.word').forEach(wordEl => {
                    const wordIndex = parseInt(wordEl.dataset.wordIndex);
                    if (wordIndex >= contextStartWord && wordIndex <= contextEndWord) {
                        wordEl.classList.add('context-limit');
                        // Mark the last word in the context range to prevent gap-fill after it
                        if (wordIndex === contextEndWord) {
                            wordEl.classList.add('context-limit-end');
                        }
                    }
                });
            }
        }
    }

    updateTimelineContextLimit() {
        // Hide context limit area by default
        this.contextLimitArea.style.display = 'none';
        
        // Show context limit area if word limit is set and no specific range is selected AND no IN/OUT markers
        const hasSelection = this.selectedRange.start !== null && this.selectedRange.end !== null;
        const hasMarkers = this.contextMarkers.in !== null || this.contextMarkers.out !== null;
        if (this.settings.wordLimit > 0 && !hasSelection && !hasMarkers && this.wordCount > 0) {
            const totalWords = this.wordCount;
            
            if (totalWords > this.settings.wordLimit) {
                // Calculate the range that would be used: last_word - limit to last_word
                const contextStartWord = totalWords - this.settings.wordLimit;
                const contextEndWord = totalWords - 1;
                
                // Calculate percentages for timeline positioning
                const startPercent = (contextStartWord / totalWords) * 100;
                const endPercent = (contextEndWord / totalWords) * 100;
                const widthPercent = endPercent - startPercent;
                
                // Position and show the context limit area
                this.contextLimitArea.style.left = `${startPercent}%`;
                this.contextLimitArea.style.width = `${widthPercent}%`;
                this.contextLimitArea.style.display = 'block';
            }
        }
    }

    addNoteMarker(position, noteId) {
        const marker = document.createElement('div');
        marker.className = 'note-marker new';
        marker.dataset.noteId = noteId;
        marker.style.left = `${position}%`;
        marker.title = `Note created at ${position.toFixed(1)}%`;
        
        marker.addEventListener('click', () => {
            // Scroll to note or highlight it
            this.highlightNote(noteId);
        });
        
        this.noteMarkers.appendChild(marker);
        
        // Remove animation class
        setTimeout(() => marker.classList.remove('new'), 500);
    }

    // Note handling
    handleGenerateNote(mode = 'normal') {
        const header = this.noteHeaderInput.value.trim();
        const sessionContext = this.sessionTopicInput.value.trim();
        
        if (!header) {
            alert('Please enter a note header');
            return;
        }

        // Determine context using priority hierarchy: Selection > IN/OUT markers > Word limit
        let startWordIndex = null;
        let endWordIndex = null;
        
        if (this.selectedRange.start !== null && this.selectedRange.end !== null) {
            // Priority 1: Highlighted selection
            startWordIndex = Math.min(this.selectedRange.start, this.selectedRange.end);
            endWordIndex = Math.max(this.selectedRange.start, this.selectedRange.end);
        } else if (this.contextMarkers.in !== null || this.contextMarkers.out !== null) {
            // Priority 2: IN/OUT markers
            if (this.contextMarkers.in !== null && this.contextMarkers.out !== null) {
                // Both markers set - use the range between them
                startWordIndex = Math.min(this.contextMarkers.in, this.contextMarkers.out);
                endWordIndex = Math.max(this.contextMarkers.in, this.contextMarkers.out);
            } else if (this.contextMarkers.in !== null) {
                // Only IN marker set - from IN to end of transcript
                startWordIndex = this.contextMarkers.in;
                endWordIndex = this.wordCount - 1;
            } else if (this.contextMarkers.out !== null) {
                // Only OUT marker set - from start to OUT
                startWordIndex = 0;
                endWordIndex = this.contextMarkers.out;
            }
        } else if (this.settings.wordLimit > 0 && this.wordCount > this.settings.wordLimit) {
            // Priority 3: Word limit (last N words)
            startWordIndex = this.wordCount - this.settings.wordLimit;
            endWordIndex = this.wordCount - 1;
        }
        
        // Show user feedback about selected context
        if (startWordIndex !== null && endWordIndex !== null) {
            const wordCount = endWordIndex - startWordIndex + 1;
        }

        const noteData = {
            header,
            sessionContext,
            mode, // 'normal', 'text-only', 'screenshots-only'
            selectedScreenshots: Array.from(this.selectedScreenshots),
            timelinePosition: this.currentPosition,
            startWordIndex,
            endWordIndex
        };

        // Send note generation request to main process
        if (window.electronAPI) {
            window.electronAPI.generateNote(noteData);
        }

        // Show loading state
        this.generateNoteBtn.textContent = 'Generating...';
        this.generateNoteBtn.disabled = true;
    }

    async loadExistingNotes() {
        try {
            if (window.electronAPI) {
                const notesContent = await window.electronAPI.loadNotes();
                if (notesContent) {
                    // Split the content by H2 headers to create individual note entries
                    const noteBlocks = notesContent.split(/(?=<h2>)/);
                    
                    // Clear the editor
                    this.notesEditor.innerHTML = '';
                    
                    // Process each note block
                    noteBlocks.forEach((block, index) => {
                        const trimmedBlock = block.trim();
                        if (trimmedBlock) {
                            // Create a note entry wrapper for each block
                            const noteElement = document.createElement('div');
                            noteElement.className = 'note-entry';
                            noteElement.dataset.noteId = `loaded-note-${index}`;
                            noteElement.innerHTML = trimmedBlock;
                            
                            this.notesEditor.appendChild(noteElement);
                        }
                    });
                    
                    // Add a small delay to ensure DOM is fully updated
                    setTimeout(() => {
                        this.setupNoteClickHandlers();
                        this.extractAndDisplayNoteMarkers();
                        // Enable autosave now that notes are loaded
                        this.notesLoaded = true;
                    }, 100);
                } else {
                    // No existing notes, but still enable autosave
                    this.notesLoaded = true;
                }
            }
        } catch (error) {
            console.error('Error loading existing notes:', error);
        }
    }

    extractAndDisplayNoteMarkers() {
        // Clear existing note markers
        this.noteMarkers.innerHTML = '';
        
        // Extract note positions from all H2 headers with word indices
        const h2Elements = this.notesEditor.querySelectorAll('h2');
        const notePositions = [];
        
        h2Elements.forEach((h2, index) => {
            // Look for a word index comment after the h2
            let nextNode = h2.nextSibling;
            let commentNode = null;
            
            // Search through the next few siblings to find the comment node
            while (nextNode && !commentNode) {
                if (nextNode.nodeType === Node.COMMENT_NODE) {
                    commentNode = nextNode;
                    break;
                } else if (nextNode.nodeType === Node.TEXT_NODE && nextNode.textContent.trim() === '') {
                    // Skip empty text nodes (spaces/whitespace)
                    nextNode = nextNode.nextSibling;
                } else {
                    // Stop if we encounter non-empty text or other elements
                    break;
                }
            }
            
            if (commentNode) {
                const match = commentNode.textContent.match(/words:(\d+)-(\d+)/);
                if (match) {
                    const startWord = parseInt(match[1]);
                    const endWord = parseInt(match[2]);
                    const noteTitle = h2.textContent.trim();
                    
                    notePositions.push({
                        startWord,
                        endWord,
                        title: noteTitle,
                        element: h2,
                        id: `note-marker-${index}`
                    });
                }
            }
        });
        
        // Create timeline markers for each note
        notePositions.forEach(note => {
            this.addTimelineNoteMarker(note);
        });
        
        console.log(`Added ${notePositions.length} note markers to timeline`);
    }

    addTimelineNoteMarker(noteData) {
        if (this.wordCount === 0) return;
        
        // Calculate percentage position based on start word index
        const percentage = (noteData.startWord / this.wordCount) * 100;
        
        // Create marker element
        const marker = document.createElement('div');
        marker.className = 'timeline-note-marker';
        marker.dataset.noteId = noteData.id;
        marker.dataset.startWord = noteData.startWord;
        marker.dataset.endWord = noteData.endWord;
        marker.style.left = `${percentage}%`;
        marker.title = `${noteData.title} (words ${noteData.startWord}-${noteData.endWord})`;
        
        // Add click handler to jump to note
        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('Clicked note marker:', noteData.title, 'at words', noteData.startWord, '-', noteData.endWord);
            this.jumpToNote(noteData);
        });
        
        this.noteMarkers.appendChild(marker);
    }

    jumpToNote(noteData) {
        console.log('jumpToNote called with:', noteData);
        
        // First, scroll to the note in the notes editor
        if (noteData.element) {
            console.log('Found note element:', noteData.element);
            const noteEntry = noteData.element.closest('.note-entry');
            
            if (noteEntry) {
                console.log('Found note entry:', noteEntry);
                
                // Get the notes editor container
                const notesEditor = this.notesEditor;
                
                // Calculate position relative to the scrollable container
                let relativeTop = 0;
                let element = noteEntry;
                
                // Walk up the DOM tree to calculate the relative position within the notes editor
                while (element && element !== notesEditor) {
                    relativeTop += element.offsetTop;
                    element = element.offsetParent;
                }
                
                // Position the note header just below the WYSIWYG toolbar
                const targetScrollTop = relativeTop - 10; // Small padding from top
                
                console.log('Note relative top:', relativeTop);
                console.log('Target scroll position:', targetScrollTop);
                console.log('Current scroll position:', notesEditor.scrollTop);
                
                // Monitor scroll completion using position checking and stagnation detection
                const finalScrollTop = Math.max(0, targetScrollTop);
                let scrollCompleted = false;
                let lastScrollTop = notesEditor.scrollTop;
                let stagnationCount = 0;
                
                const checkScrollCompletion = () => {
                    if (scrollCompleted) return;
                    
                    const currentScrollTop = notesEditor.scrollTop;
                    const scrollDifference = Math.abs(currentScrollTop - finalScrollTop);
                    const scrollMovement = Math.abs(currentScrollTop - lastScrollTop);
                    
                    console.log('Checking scroll completion:', {
                        current: currentScrollTop,
                        target: finalScrollTop,
                        difference: scrollDifference,
                        movement: scrollMovement,
                        stagnation: stagnationCount
                    });
                    
                    // Method 1: Position-based completion (within 5px tolerance for better reliability)
                    if (scrollDifference <= 5) {
                        console.log('Notes editor scroll completed (position match), starting transcript highlighting');
                        scrollCompleted = true;
                        this.highlightNoteRange(noteData.startWord, noteData.endWord);
                        return;
                    }
                    
                    // Method 2: Stagnation detection (scroll stopped moving)
                    if (scrollMovement < 1) {
                        stagnationCount++;
                        if (stagnationCount >= 3) { // 3 consecutive checks with no movement
                            console.log('Notes editor scroll completed (stagnation detected), starting transcript highlighting');
                            scrollCompleted = true;
                            this.highlightNoteRange(noteData.startWord, noteData.endWord);
                            return;
                        }
                    } else {
                        stagnationCount = 0; // Reset stagnation counter if movement detected
                    }
                    
                    lastScrollTop = currentScrollTop;
                    
                    // Continue monitoring
                    setTimeout(checkScrollCompletion, 50);
                };
                
                // Start monitoring after a brief delay to let scroll animation begin
                setTimeout(checkScrollCompletion, 100);
                
                // Absolute fallback timeout
                setTimeout(() => {
                    if (!scrollCompleted) {
                        console.log('Using absolute fallback timeout for scroll completion');
                        scrollCompleted = true;
                        this.highlightNoteRange(noteData.startWord, noteData.endWord);
                    }
                }, 1000);
                
                // Smooth scroll to the note
                notesEditor.scrollTo({
                    top: Math.max(0, targetScrollTop),
                    behavior: 'smooth'
                });
                
                // Temporarily highlight the note
                noteEntry.classList.add('highlighted');
                setTimeout(() => {
                    noteEntry.classList.remove('highlighted');
                }, 2000);
            } else {
                console.log('No note entry found for element');
            }
        } else {
            console.log('No element found in noteData');
            // If no notes editor scroll needed, go straight to transcript
            this.highlightNoteRange(noteData.startWord, noteData.endWord);
        }
    }

    setupNoteClickHandlers() {
        // Make H2 headers with word indices clickable
        const h2Elements = this.notesEditor.querySelectorAll('h2');
        h2Elements.forEach(h2 => {
            // Look for a word index comment after the h2 (might have text nodes in between)
            let nextNode = h2.nextSibling;
            let commentNode = null;
            
            // Search through the next few siblings to find the comment node
            while (nextNode && !commentNode) {
                if (nextNode.nodeType === Node.COMMENT_NODE) {
                    commentNode = nextNode;
                    break;
                } else if (nextNode.nodeType === Node.TEXT_NODE && nextNode.textContent.trim() === '') {
                    // Skip empty text nodes (spaces/whitespace)
                    nextNode = nextNode.nextSibling;
                } else {
                    // Stop if we encounter non-empty text or other elements
                    break;
                }
            }
            
            if (commentNode) {
                const match = commentNode.textContent.match(/words:(\d+)-(\d+)/);
                if (match) {
                    const startWord = parseInt(match[1]);
                    const endWord = parseInt(match[2]);
                    
                    // Make h2 clickable with both inline styles and CSS class
                    h2.style.cursor = 'pointer';
                    h2.style.textDecoration = 'underline';
                    h2.classList.add('clickable-note-header');
                    h2.title = `Click to highlight words ${startWord}-${endWord} in transcript`;
                    
                    
                    h2.addEventListener('click', () => {
                        this.highlightNoteRange(startWord, endWord);
                    });
                }
            }
        });
    }

    highlightNoteRange(startWord, endWord) {
        console.log('highlightNoteRange called for words:', startWord, '-', endWord);
        
        // Update selection state
        this.selectedRange.start = startWord;
        this.selectedRange.end = endWord;
        this.selectedRange.active = false;
        
        // Highlight in transcript
        this.updateTranscriptVisualSelection();
        this.updateSelectionStatus();
        
        // Update timeline selection
        const startPercent = (startWord / this.wordCount) * 100;
        const endPercent = (endWord / this.wordCount) * 100;
        this.updateTimelineSelectionFromPercent(startPercent, endPercent);
        
        // Scroll to the selection in transcript
        const firstSelectedWord = document.querySelector(`[data-word-index="${startWord}"]`);
        if (firstSelectedWord) {
            console.log('Scrolling to transcript word:', startWord);
            firstSelectedWord.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center',
                inline: 'nearest'
            });
        } else {
            console.log('Could not find word element for index:', startWord);
        }
    }

    handleNoteCreated(noteData) {
        const { content, position, id } = noteData;
        
        // Content is already HTML from the main process, just insert it
        const noteElement = document.createElement('div');
        noteElement.className = 'note-entry';
        noteElement.dataset.noteId = id;
        noteElement.innerHTML = content;
        
        // Add note to editor (append to existing content)
        this.notesEditor.appendChild(noteElement);
        
        // Add timeline marker
        const percentage = (position / this.wordCount) * 100;
        this.addNoteMarker(percentage, id);
        
        // Clear note header
        this.noteHeaderInput.value = '';
        
        // Reset button state
        this.generateNoteBtn.textContent = 'Generate Note';
        this.generateNoteBtn.disabled = false;
        
        // Save immediately after adding a generated note
        this.saveNotes();
        
        // Enable autosave if not already enabled
        this.notesLoaded = true;
        
        // Setup click handlers for new notes
        this.setupNoteClickHandlers();
        
        // Extract and update timeline markers for all notes
        this.extractAndDisplayNoteMarkers();
    }

    highlightNote(noteId) {
        // Remove existing highlights
        document.querySelectorAll('.note-entry.highlighted').forEach(el => {
            el.classList.remove('highlighted');
        });
        
        // Highlight target note
        const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
        if (noteElement) {
            noteElement.classList.add('highlighted');
            noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Remove highlight after 3 seconds
            setTimeout(() => noteElement.classList.remove('highlighted'), 3000);
        }
    }

    handleNotesChange() {
        // Don't autosave until notes are properly loaded to prevent wiping on refresh
        if (!this.notesLoaded) {
            return;
        }
        
        // Clear any existing autosave timeout
        clearTimeout(this.autoSaveTimeout);
        
        // Set up debounced autosave (3 seconds of inactivity)
        this.autoSaveTimeout = setTimeout(() => {
            this.saveNotes();
            this.showSaveStatus('saved');
        }, 3000);
        
        // Show unsaved status (gray dot)
        this.showSaveStatus('unsaved');
    }

    showSaveStatus(status) {
        // Update or create save status indicator
        let statusIndicator = document.getElementById('save-status');
        if (!statusIndicator) {
            statusIndicator = document.createElement('div');
            statusIndicator.id = 'save-status';
            statusIndicator.className = 'save-status';
            statusIndicator.innerHTML = 'Autosaved <span class="status-dot"></span>';
            
            // Add to the formatting toolbar on the right side
            const toolbar = document.querySelector('.formatting-toolbar');
            toolbar.appendChild(statusIndicator);
        }
        
        // Update dot status
        const dot = statusIndicator.querySelector('.status-dot');
        if (dot) {
            dot.className = 'status-dot';
            if (status === 'saved') {
                dot.classList.add('saved');
            } else if (status === 'unsaved') {
                dot.classList.add('unsaved');
            } else if (status === 'error') {
                dot.classList.add('error');
            }
        }
    }

    saveNotes() {
        const content = this.notesEditor.innerHTML;
        if (window.electronAPI) {
            window.electronAPI.saveNotes(content).then(() => {
                this.showSaveStatus('saved');
            }).catch((error) => {
                console.error('Error saving notes:', error);
                this.showSaveStatus('error');
            });
        }
    }

    handleExportNotes() {
        if (window.electronAPI) {
            window.electronAPI.exportNotes();
        }
    }

    handleClearNotes() {
        if (confirm('Are you sure you want to clear all notes? This action cannot be undone.')) {
            this.notesEditor.innerHTML = '';
            this.noteMarkers.innerHTML = '';
            this.saveNotes();
        }
    }

    // Summary handling
    handleSummarize() {
        this.summarizeBtn.textContent = 'Summarizing...';
        this.summarizeBtn.disabled = true;
        
        const sessionContext = this.sessionTopicInput.value.trim();
        
        if (window.electronAPI) {
            window.electronAPI.createSummary(sessionContext);
        }
    }

    handleSummaryUpdate(summary) {
        // Reset button state
        this.summarizeBtn.textContent = 'Summarize';
        this.summarizeBtn.disabled = false;
        
        // Could show summary in a modal or status update
        console.log('Summary updated:', summary);
    }

    // Settings handling
    showSettings() {
        // Load current settings
        this.wordLimitInput.value = this.settings.wordLimit;
        this.readOnlyModeInput.checked = this.settings.readOnlyMode;
        this.autoSaveInput.checked = this.settings.autoSave;
        this.followTranscriptInput.checked = this.settings.followTranscript;
        
        this.settingsModal.classList.remove('hidden');
    }

    hideSettings() {
        this.settingsModal.classList.add('hidden');
    }

    saveSettings() {
        // Update only the general settings, preserve audio settings
        this.settings = {
            ...this.settings, // Preserve existing settings including audio
            wordLimit: parseInt(this.wordLimitInput.value) || 0,
            readOnlyMode: this.readOnlyModeInput.checked,
            autoSave: this.autoSaveInput.checked,
            followTranscript: this.followTranscriptInput.checked
        };
        
        console.log('Saving settings, preserving audio:', this.settings);
        
        if (window.electronAPI) {
            window.electronAPI.updateSettings(this.settings);
        }
        
        // Update context limit highlighting when word limit changes
        this.updateContextLimitHighlighting();
        this.updateTimelineContextLimit();
        
        this.hideSettings();
    }

    updateSettings(settings) {
        this.settings = { ...this.settings, ...settings };
        // Update context limit highlighting when settings change
        this.updateContextLimitHighlighting();
        this.updateTimelineContextLimit();
    }

    handleAppDataUpdate(appData) {
        const { transcriptFilename } = appData;
        
        // Set the transcript filename as default session topic if field is empty
        if (transcriptFilename && this.sessionTopicInput && !this.sessionTopicInput.value.trim()) {
            // Clean up the filename to be more readable
            const cleanedFilename = transcriptFilename
                .replace(/^\d{8}\s\d{4}\s/, '') // Remove date/time prefix like "20250603 1030 "
                .replace(/\s+/g, ' ') // Normalize spaces
                .trim();
            
            this.sessionTopicInput.value = cleanedFilename;
            this.sessionTopicInput.placeholder = cleanedFilename;
            
            // Send the updated context to main process
            this.updateSessionContext(cleanedFilename);
        }
        
        // Load existing notes now that we have app data
        this.loadExistingNotes();
    }

    // Status updates
    updateStatus(status) {
        this.connectionStatus.textContent = status.connected ? 'Connected' : 'Disconnected';
        this.connectionStatus.className = status.connected ? 'status-connected' : 'status-disconnected';
    }

    updateCost(costData) {
        this.apiCost.textContent = `$${costData.total.toFixed(4)}`;
    }

    updateSelectedScreenshotsStatus() {
        const count = this.selectedScreenshots.size;
        this.selectedScreenshotsStatus.textContent = `${count} screenshot${count !== 1 ? 's' : ''} selected`;
    }

    updateSessionContext(context) {
        if (window.electronAPI) {
            window.electronAPI.updateSessionContext(context);
        }
    }

    updateNoteHeader(header) {
        // Could save as draft or provide auto-complete
    }

    updateWordCountDisplay() {
        this.wordCountDisplay.textContent = `${this.wordCount.toLocaleString()} words`;
    }

    startStatusUpdates() {
        setInterval(() => {
            const elapsed = Date.now() - this.sessionStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;
            
            if (hours > 0) {
                this.sessionTime.textContent = `Session: ${hours}:${remainingMinutes.toString().padStart(2, '0')}`;
                this.timelineDuration.textContent = `${hours}:${remainingMinutes.toString().padStart(2, '0')}`;
            } else {
                this.sessionTime.textContent = `Session: ${minutes}:${(Math.floor((elapsed % 60000) / 1000)).toString().padStart(2, '0')}`;
                this.timelineDuration.textContent = `${minutes}:${(Math.floor((elapsed % 60000) / 1000)).toString().padStart(2, '0')}`;
            }
        }, 1000);
    }

    // Keyboard shortcuts
    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 's':
                    e.preventDefault();
                    this.saveNotes();
                    break;
                case 'n':
                    e.preventDefault();
                    this.noteHeaderInput.focus();
                    break;
                case ',':
                    e.preventDefault();
                    this.showSettings();
                    break;
                case 'b':
                    if (e.target === this.notesEditor) {
                        e.preventDefault();
                        this.formatText('bold');
                    }
                    break;
                case 'i':
                    if (e.target === this.notesEditor) {
                        e.preventDefault();
                        this.formatText('italic');
                    }
                    break;
                case 'Enter':
                    if (e.target === this.noteHeaderInput) {
                        e.preventDefault();
                        this.handleGenerateNote();
                    }
                    break;
            }
        }
        
        if (e.key === 'Escape') {
            this.hideSettings();
            this.clearSelection();
        }
        
        // Clear selection with Delete key for better UX
        if (e.key === 'Delete' && (e.target.closest('.transcript-content') || e.target.closest('.timeline'))) {
            e.preventDefault();
            this.clearSelection();
        }
        
        // IN/OUT marker shortcuts (only when not in notes editor)
        if (e.target !== this.notesEditor && e.target !== this.noteHeaderInput && e.target !== this.sessionTopicInput) {
            if (e.key === 'i' || e.key === 'I') {
                e.preventDefault();
                this.toggleInMarker();
            }
            if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                this.toggleOutMarker();
            }
        }
    }

    toggleInMarker() {
        if (this.lastClickedWord === null) {
            console.log('No word selected. Click on a word first.');
            return;
        }
        
        // If clicking on the same word that already has IN marker, remove it
        if (this.contextMarkers.in === this.lastClickedWord) {
            this.contextMarkers.in = null;
        } else {
            this.contextMarkers.in = this.lastClickedWord;
        }
        
        this.updateContextMarkersDisplay();
        this.updateContextHighlighting();
        this.updateContextPreview();
    }

    toggleOutMarker() {
        if (this.lastClickedWord === null) {
            console.log('No word selected. Click on a word first.');
            return;
        }
        
        // If clicking on the same word that already has OUT marker, remove it
        if (this.contextMarkers.out === this.lastClickedWord) {
            this.contextMarkers.out = null;
        } else {
            this.contextMarkers.out = this.lastClickedWord;
        }
        
        this.updateContextMarkersDisplay();
        this.updateContextHighlighting();
        this.updateContextPreview();
    }

    updateContextMarkersDisplay() {
        // Hide all markers first
        this.inMarker.style.display = 'none';
        this.outMarker.style.display = 'none';
        this.inOutRangeArea.style.display = 'none';
        
        if (this.wordCount === 0) return;
        
        // Show IN marker if set
        if (this.contextMarkers.in !== null) {
            const inPercent = (this.contextMarkers.in / this.wordCount) * 100;
            this.inMarker.style.left = `${inPercent}%`;
            this.inMarker.style.display = 'block';
        }
        
        // Show OUT marker if set
        if (this.contextMarkers.out !== null) {
            const outPercent = (this.contextMarkers.out / this.wordCount) * 100;
            this.outMarker.style.left = `${outPercent}%`;
            this.outMarker.style.display = 'block';
        }
        
        // Show range area if we have markers
        if (this.contextMarkers.in !== null || this.contextMarkers.out !== null) {
            let startWord, endWord;
            
            if (this.contextMarkers.in !== null && this.contextMarkers.out !== null) {
                // Both markers set - use the range between them
                startWord = Math.min(this.contextMarkers.in, this.contextMarkers.out);
                endWord = Math.max(this.contextMarkers.in, this.contextMarkers.out);
            } else if (this.contextMarkers.in !== null) {
                // Only IN marker set - from IN to end of transcript
                startWord = this.contextMarkers.in;
                endWord = this.wordCount - 1;
            } else if (this.contextMarkers.out !== null) {
                // Only OUT marker set - from start to OUT
                startWord = 0;
                endWord = this.contextMarkers.out;
            }
            
            const startPercent = (startWord / this.wordCount) * 100;
            const endPercent = (endWord / this.wordCount) * 100;
            const widthPercent = endPercent - startPercent;
            
            this.inOutRangeArea.style.left = `${startPercent}%`;
            this.inOutRangeArea.style.width = `${widthPercent}%`;
            this.inOutRangeArea.style.display = 'block';
            
            // Hide yellow context limit area when green IN/OUT range is active
            this.contextLimitArea.style.display = 'none';
        } else {
            // No markers set, allow context limit area to show if applicable
            this.updateTimelineContextLimit();
        }
    }

    updateContextHighlighting() {
        // Clear existing IN/OUT range highlighting
        document.querySelectorAll('.word').forEach(el => {
            el.classList.remove('in-out-range', 'in-out-range-end');
        });
        
        // Apply IN/OUT range highlighting if markers are set and no selection is active
        const hasSelection = this.selectedRange.start !== null && this.selectedRange.end !== null;
        if ((this.contextMarkers.in !== null || this.contextMarkers.out !== null) && !hasSelection) {
            let startWord, endWord;
            
            if (this.contextMarkers.in !== null && this.contextMarkers.out !== null) {
                // Both markers set - use the range between them
                startWord = Math.min(this.contextMarkers.in, this.contextMarkers.out);
                endWord = Math.max(this.contextMarkers.in, this.contextMarkers.out);
            } else if (this.contextMarkers.in !== null) {
                // Only IN marker set - from IN to end of transcript
                startWord = this.contextMarkers.in;
                endWord = this.wordCount - 1;
            } else if (this.contextMarkers.out !== null) {
                // Only OUT marker set - from start to OUT
                startWord = 0;
                endWord = this.contextMarkers.out;
            }
            
            // Apply highlighting to words in this range
            document.querySelectorAll('.word').forEach(wordEl => {
                const wordIndex = parseInt(wordEl.dataset.wordIndex);
                if (wordIndex >= startWord && wordIndex <= endWord) {
                    wordEl.classList.add('in-out-range');
                    // Mark the last word in the range to prevent gap-fill after it
                    if (wordIndex === endWord) {
                        wordEl.classList.add('in-out-range-end');
                    }
                }
            });
            
            // Hide yellow context limit highlighting when green IN/OUT range is active
            document.querySelectorAll('.word').forEach(el => {
                el.classList.remove('context-limit', 'context-limit-end');
            });
            this.contextLimitArea.style.display = 'none';
        } else {
            // No IN/OUT range active, allow context limit highlighting to show
            this.updateContextLimitHighlighting();
        }
    }

    updateContextPreview() {
        // This function should trigger an update of the context preview
        // The actual context selection logic will be updated separately
        this.updateSelectionStatus();
    }

    renderSegmentMarkers() {
        if (!this.transcriptMetadata || !this.segmentMarkers) return;
        
        // Clear existing segment markers
        this.segmentMarkers.innerHTML = '';
        
        if (this.wordCount === 0) return;
        
        // Render each segment as a visual marker on the timeline
        this.transcriptMetadata.segments.forEach((segment, index) => {
            const markerElement = document.createElement('div');
            markerElement.className = 'segment-marker';
            markerElement.dataset.segmentId = segment.id;
            markerElement.dataset.source = segment.source;
            
            // Calculate position based on start word index
            const positionPercent = (segment.startWordIndex / this.wordCount) * 100;
            markerElement.style.left = `${positionPercent}%`;
            
            // Set visual style based on source
            if (segment.source === 'initial-load') {
                markerElement.classList.add('segment-initial');
            } else if (segment.source === 'live-transcription') {
                markerElement.classList.add('segment-live');
            }
            
            // Add tooltip with segment info
            const timestamp = new Date(segment.timestamp).toLocaleTimeString();
            const wordRange = `${segment.startWordIndex}-${segment.endWordIndex}`;
            markerElement.title = `Segment ${index + 1}\nTime: ${timestamp}\nWords: ${wordRange}\nSource: ${segment.source}`;
            
            this.segmentMarkers.appendChild(markerElement);
        });
        
        // Segments are reconstructed with default appearance - no additional highlighting needed
        
        console.log(`Rendered ${this.transcriptMetadata.segments.length} segment markers`);
    }


    reconstructTranscriptFromSegments(allLines, metadata) {
        console.log('Reconstructing transcript from segments...');
        
        // Clear existing transcript content
        this.transcriptContent.innerHTML = '';
        this.transcriptLines = [];
        
        // Get all words from all lines to work with word indices
        const allWords = [];
        const wordToLineMap = []; // Maps word index to original line info
        
        allLines.forEach(line => {
            const words = line.content.split(/\s+/).filter(word => word.length > 0);
            words.forEach(word => {
                allWords.push(word);
                wordToLineMap.push({
                    originalLine: line,
                    wordIndexInLine: allWords.length - 1 - (allWords.length - words.length)
                });
            });
        });
        
        // Reconstruct segments as separate transcript sections
        metadata.segments.forEach((segment, segmentIndex) => {
            const segmentWords = allWords.slice(segment.startWordIndex, segment.endWordIndex + 1);
            
            if (segmentWords.length > 0) {
                // Get the original line info for the first word in this segment
                const firstWordInfo = wordToLineMap[segment.startWordIndex];
                const originalLine = firstWordInfo.originalLine;
                
                // Create a segment line with the segment's words
                // Use metadata timestamp in 24-hour format
                const metadataTimestamp = new Date(segment.timestamp).toLocaleTimeString('en-GB', { hour12: false });
                
                const segmentLine = {
                    timestamp: metadataTimestamp,
                    speaker: originalLine.speaker || (segment.source === 'live-transcription' ? 'Live Audio' : 'Speaker'),
                    content: segmentWords.join(' '),
                    wordIndex: segment.startWordIndex,
                    wordCount: segmentWords.length,
                    segmentSource: segment.source,
                    segmentId: segment.id
                };
                
                this.transcriptLines.push(segmentLine);
                
                // Add the line - all segments get identical treatment and appearance
                this.addTranscriptLine(segmentLine, false); // No animation for reconstruction
                
                // No special styling - all segments should look identical to default appearance
            }
        });
        
        console.log(`Reconstructed ${metadata.segments.length} segments`);
    }

    formatText(command, value = null) {
        // Focus the editor first
        this.notesEditor.focus();
        
        // Execute the formatting command
        if (value) {
            document.execCommand(command, false, value);
        } else {
            document.execCommand(command);
        }
        
        // Trigger autosave handling
        this.handleNotesChange();
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing renderer app...');
    console.log('electronAPI available:', !!window.electronAPI);
    
    try {
        window.rendererApp = new RendererApp();
        console.log('RendererApp initialized successfully');
    } catch (error) {
        console.error('Error initializing RendererApp:', error);
    }
});

