// Preload script - securely exposes Electron APIs to renderer process

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // File operations
    selectTranscriptFile: () => ipcRenderer.invoke('select-transcript-file'),
    selectScreenshotsDir: () => ipcRenderer.invoke('select-screenshots-dir'),
    openFile: () => ipcRenderer.invoke('open-file'),
    
    // Summarizer operations
    createSummary: (sessionContext) => ipcRenderer.invoke('create-summary', sessionContext),
    generateNote: (noteData) => ipcRenderer.invoke('generate-note', noteData),
    
    // Screenshot operations
    updateScreenshotSelection: (selectedPaths) => ipcRenderer.invoke('update-screenshot-selection', selectedPaths),
    setScreenshotFilter: (filter) => ipcRenderer.invoke('set-screenshot-filter', filter),
    
    // Settings
    updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
    
    // Notes operations
    loadNotes: () => ipcRenderer.invoke('load-notes'),
    saveNotes: (content) => ipcRenderer.invoke('save-notes', content),
    exportNotes: () => ipcRenderer.invoke('export-notes'),
    
    // Timeline operations
    seekTimeline: (position) => ipcRenderer.invoke('seek-timeline', position),
    selectTimelineRange: (startPercent, endPercent) => ipcRenderer.invoke('select-timeline-range', startPercent, endPercent),
    
    // Session operations
    updateSessionContext: (context) => ipcRenderer.invoke('update-session-context', context),
    
    // External operations
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    
    // Audio recording operations
    getAudioStatus: () => ipcRenderer.invoke('get-audio-status'),
    refreshAudioDetection: () => ipcRenderer.invoke('refresh-audio-detection'),
    updateAudioSettings: (audioSettings) => ipcRenderer.invoke('update-audio-settings', audioSettings),
    startAudioRecording: (sessionContext) => ipcRenderer.invoke('start-audio-recording', sessionContext),
    stopAudioRecording: () => ipcRenderer.invoke('stop-audio-recording'),
    processAudioChunk: (chunkBuffer) => ipcRenderer.invoke('process-audio-chunk', chunkBuffer),
    openBlackHoleInstaller: () => ipcRenderer.invoke('open-blackhole-installer'),
    openAudioMidiSetup: () => ipcRenderer.invoke('open-audio-midi-setup'),
    
    // Renderer ready signal
    rendererReady: () => ipcRenderer.invoke('renderer-ready'),
    
    // Event listeners (from main to renderer)
    onTranscriptUpdate: (callback) => {
        ipcRenderer.on('transcript-update', (event, data) => callback(data));
    },
    
    onScreenshotsUpdate: (callback) => {
        ipcRenderer.on('screenshots-update', (event, screenshots) => callback(screenshots));
    },
    
    onNoteCreated: (callback) => {
        ipcRenderer.on('note-created', (event, note) => callback(note));
    },
    
    onSummaryUpdate: (callback) => {
        ipcRenderer.on('summary-update', (event, summary) => callback(summary));
    },
    
    onCostUpdate: (callback) => {
        ipcRenderer.on('cost-update', (event, cost) => callback(cost));
    },
    
    onStatusUpdate: (callback) => {
        ipcRenderer.on('status-update', (event, status) => callback(status));
    },
    
    onSettingsUpdate: (callback) => {
        ipcRenderer.on('settings-update', (event, settings) => callback(settings));
    },
    
    onAppDataUpdate: (callback) => {
        ipcRenderer.on('app-data-update', (event, appData) => callback(appData));
    },
    
    // Remove listeners (cleanup)
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});

// Expose app info
contextBridge.exposeInMainWorld('appInfo', {
    platform: process.platform,
    version: process.env.npm_package_version || '1.0.0',
    electron: process.versions.electron,
    node: process.versions.node
});