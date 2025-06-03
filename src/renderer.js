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
            autoSave: true
        };
        
        console.log('Initializing elements...');
        this.initializeElements();
        
        console.log('Setting up event listeners...');
        this.setupEventListeners();
        
        console.log('Setting up IPC...');
        this.setupIPC();
        
        console.log('Starting status updates...');
        this.startStatusUpdates();
        
        console.log('RendererApp constructor completed');
        
        // Signal to main process that renderer is ready
        if (window.electronAPI) {
            window.electronAPI.rendererReady();
        }
    }

    initializeElements() {
        // Input elements
        this.sessionTopicInput = document.getElementById('session-topic');
        this.noteHeaderInput = document.getElementById('note-header');
        this.screenshotSearchInput = document.getElementById('screenshot-search');
        this.wordLimitInput = document.getElementById('word-limit');
        this.readOnlyModeInput = document.getElementById('read-only-mode');
        this.autoSaveInput = document.getElementById('auto-save');

        // Display elements
        this.transcriptContent = document.getElementById('transcript-content');
        this.screenshotGrid = document.getElementById('screenshot-grid');
        this.notesEditor = document.getElementById('notes-editor');
        this.timeline = document.getElementById('timeline');
        this.timelineCursor = document.getElementById('timeline-cursor');
        this.noteMarkers = document.getElementById('note-markers');
        this.selectionArea = document.getElementById('selection-area');

        // Button elements
        this.summarizeBtn = document.getElementById('summarize-btn');
        this.settingsBtn = document.getElementById('settings-btn');
        this.generateNoteBtn = document.getElementById('generate-note');
        this.noteTextOnlyBtn = document.getElementById('note-text-only');
        this.noteScreenshotsOnlyBtn = document.getElementById('note-screenshots-only');
        this.sessionFilterBtn = document.getElementById('session-filter');
        this.allFilterBtn = document.getElementById('all-filter');
        this.exportNotesBtn = document.getElementById('export-notes');
        this.clearNotesBtn = document.getElementById('clear-notes');
        this.saveSettingsBtn = document.getElementById('save-settings');
        this.closeSettingsBtn = document.getElementById('close-settings');

        // Modal elements
        this.settingsModal = document.getElementById('settings-modal');

        // Status elements
        this.connectionStatus = document.getElementById('connection-status');
        this.apiCost = document.getElementById('api-cost');
        this.selectedScreenshotsStatus = document.getElementById('selected-screenshots');
        this.sessionTime = document.getElementById('session-time');
        this.timelineDuration = document.getElementById('timeline-duration');
        this.wordCountDisplay = document.getElementById('word-count');
    }

    setupEventListeners() {
        // Button clicks
        this.summarizeBtn.addEventListener('click', () => this.handleSummarize());
        this.settingsBtn.addEventListener('click', () => this.showSettings());
        this.generateNoteBtn.addEventListener('click', () => this.handleGenerateNote());
        this.noteTextOnlyBtn.addEventListener('click', () => this.handleGenerateNote('text-only'));
        this.noteScreenshotsOnlyBtn.addEventListener('click', () => this.handleGenerateNote('screenshots-only'));
        this.exportNotesBtn.addEventListener('click', () => this.handleExportNotes());
        this.clearNotesBtn.addEventListener('click', () => this.handleClearNotes());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.closeSettingsBtn.addEventListener('click', () => this.hideSettings());

        // Filter buttons
        this.sessionFilterBtn.addEventListener('click', () => this.setScreenshotFilter('session'));
        this.allFilterBtn.addEventListener('click', () => this.setScreenshotFilter('all'));

        // Input changes
        this.screenshotSearchInput.addEventListener('input', (e) => this.filterScreenshots(e.target.value));
        this.sessionTopicInput.addEventListener('input', (e) => this.updateSessionContext(e.target.value));
        this.noteHeaderInput.addEventListener('input', (e) => this.updateNoteHeader(e.target.value));

        // Timeline interactions
        this.timeline.addEventListener('click', (e) => this.handleTimelineClick(e));
        this.timeline.addEventListener('mousedown', (e) => this.startTimelineSelection(e));

        // Notes editor
        this.notesEditor.addEventListener('input', () => this.handleNotesChange());

        // Modal interactions
        this.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.settingsModal) this.hideSettings();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        // Prevent context menu on timeline for better UX
        this.timeline.addEventListener('contextmenu', (e) => e.preventDefault());
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
        }
    }

    // Transcript handling
    handleTranscriptUpdate(data) {
        const { lines, wordCount, currentPosition } = data;
        
        // Add new lines with animation
        lines.forEach(line => {
            if (!this.transcriptLines.find(l => l.timestamp === line.timestamp)) {
                this.transcriptLines.push(line);
                this.addTranscriptLine(line, true); // true for animation
            }
        });

        this.wordCount = wordCount;
        this.currentPosition = currentPosition;
        this.updateTimeline();
        this.updateWordCountDisplay();
    }

    addTranscriptLine(line, animate = false) {
        const lineElement = document.createElement('div');
        lineElement.className = `transcript-line ${animate ? 'new' : ''}`;
        
        lineElement.innerHTML = `
            <span class="transcript-timestamp">[${line.timestamp}]</span>
            <span class="transcript-speaker">${line.speaker}:</span>
            <span class="transcript-content-text">${line.content}</span>
        `;

        this.transcriptContent.appendChild(lineElement);
        
        // Remove animation class after animation completes
        if (animate) {
            setTimeout(() => lineElement.classList.remove('new'), 300);
        }

        // Auto-scroll to bottom
        this.transcriptContent.scrollTop = this.transcriptContent.scrollHeight;
    }

    // Screenshot handling
    updateScreenshots(screenshots) {
        this.screenshotGrid.innerHTML = '';
        
        screenshots.forEach((screenshot, index) => {
            const item = document.createElement('div');
            item.className = 'screenshot-item';
            item.dataset.path = screenshot.path;
            
            if (this.selectedScreenshots.has(screenshot.path)) {
                item.classList.add('selected');
            }

            item.innerHTML = `
                <img src="file://${screenshot.path}" alt="Screenshot ${index + 1}" />
                <div class="selection-indicator">✓</div>
            `;

            item.addEventListener('click', () => this.toggleScreenshotSelection(screenshot.path, item));
            
            this.screenshotGrid.appendChild(item);
        });

        this.updateSelectedScreenshotsStatus();
    }

    toggleScreenshotSelection(path, element) {
        if (this.selectedScreenshots.has(path)) {
            this.selectedScreenshots.delete(path);
            element.classList.remove('selected');
        } else {
            this.selectedScreenshots.add(path);
            element.classList.add('selected');
        }
        
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
        
        // Update cursor position (percentage of total words)
        const percentage = Math.min((this.currentPosition / this.wordCount) * 100, 100);
        this.timelineCursor.style.left = `${percentage}%`;
    }

    handleTimelineClick(e) {
        const rect = this.timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = (x / rect.width) * 100;
        const targetPosition = Math.floor((percentage / 100) * this.wordCount);
        
        // Send timeline seek to main process
        if (window.electronAPI) {
            window.electronAPI.seekTimeline(targetPosition);
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
                
                // Send selection to main process
                if (window.electronAPI) {
                    window.electronAPI.selectTimelineRange(startPercent, endPercent);
                }
            } else {
                this.selectionArea.style.display = 'none';
            }
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
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

        const noteData = {
            header,
            sessionContext,
            mode, // 'normal', 'text-only', 'screenshots-only'
            selectedScreenshots: Array.from(this.selectedScreenshots),
            timelinePosition: this.currentPosition
        };

        // Send note generation request to main process
        if (window.electronAPI) {
            window.electronAPI.generateNote(noteData);
        }

        // Show loading state
        this.generateNoteBtn.textContent = 'Generating...';
        this.generateNoteBtn.disabled = true;
    }

    handleNoteCreated(noteData) {
        const { content, position, id } = noteData;
        
        // Add note to editor
        if (this.notesEditor.innerHTML.trim() === '' || 
            this.notesEditor.textContent === 'Generated notes will appear here...') {
            this.notesEditor.innerHTML = '';
        }
        
        const noteElement = document.createElement('div');
        noteElement.className = 'note-entry';
        noteElement.dataset.noteId = id;
        noteElement.innerHTML = content;
        
        this.notesEditor.appendChild(noteElement);
        
        // Add timeline marker
        const percentage = (position / this.wordCount) * 100;
        this.addNoteMarker(percentage, id);
        
        // Clear note header
        this.noteHeaderInput.value = '';
        
        // Reset button state
        this.generateNoteBtn.textContent = 'Generate Note';
        this.generateNoteBtn.disabled = false;
        
        // Auto-save if enabled
        if (this.settings.autoSave) {
            this.saveNotes();
        }
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
        if (this.settings.autoSave) {
            // Debounced auto-save
            clearTimeout(this.autoSaveTimeout);
            this.autoSaveTimeout = setTimeout(() => this.saveNotes(), 2000);
        }
    }

    saveNotes() {
        const content = this.notesEditor.innerHTML;
        if (window.electronAPI) {
            window.electronAPI.saveNotes(content);
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
        
        this.settingsModal.classList.remove('hidden');
    }

    hideSettings() {
        this.settingsModal.classList.add('hidden');
    }

    saveSettings() {
        this.settings = {
            wordLimit: parseInt(this.wordLimitInput.value) || 0,
            readOnlyMode: this.readOnlyModeInput.checked,
            autoSave: this.autoSaveInput.checked
        };
        
        if (window.electronAPI) {
            window.electronAPI.updateSettings(this.settings);
        }
        
        this.hideSettings();
    }

    updateSettings(settings) {
        this.settings = { ...this.settings, ...settings };
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
        }
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

// Add CSS for highlighted notes
const style = document.createElement('style');
style.textContent = `
    .note-entry.highlighted {
        background: rgba(0, 102, 204, 0.1);
        border-left: 4px solid #0066cc;
        padding-left: 12px;
        transition: all 0.3s ease;
    }
    
    .note-entry {
        margin-bottom: 16px;
        padding: 8px 0;
        border-left: 4px solid transparent;
        transition: all 0.3s ease;
    }
`;
document.head.appendChild(style);