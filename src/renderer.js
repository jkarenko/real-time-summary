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
            followTranscript: true
        };
        this.selectedRange = {
            start: null,
            end: null,
            active: false
        };
        this.notesLoaded = false; // Flag to prevent autosave until notes are loaded
        
        // Virtual scrolling properties
        this.allScreenshots = [];
        this.virtualScrollInitialized = false;
        this.scrollTimeout = null;
        
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

    // Transcript handling
    handleTranscriptUpdate(data) {
        const { lines, wordCount, currentPosition } = data;
        
        // Add new lines with animation
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
        
        // Calculate current word position based on loaded transcript lines
        let currentWordPosition = 0;
        if (this.transcriptLines.length > 0) {
            const lastLine = this.transcriptLines[this.transcriptLines.length - 1];
            currentWordPosition = lastLine.wordIndex + lastLine.wordCount;
        }
        
        // Update cursor position (percentage of current words loaded vs total)
        const percentage = Math.min((currentWordPosition / this.wordCount) * 100, 100);
        this.timelineCursor.style.left = `${percentage}%`;
        
        // Update note marker positions when word count changes
        if (this.notesLoaded) {
            this.extractAndDisplayNoteMarkers();
        }
    }

    handleTimelineClick(e) {
        const rect = this.timeline.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = (x / rect.width) * 100;
        const targetWordPosition = Math.floor((percentage / 100) * this.wordCount);
        
        // Update cursor position visually
        this.timelineCursor.style.left = `${percentage}%`;
        
        // Highlight the corresponding word in transcript
        this.highlightWordAtPosition(targetWordPosition);
        
        // Send timeline seek to main process
        if (window.electronAPI) {
            window.electronAPI.seekTimeline(targetWordPosition);
        }
    }

    highlightWordAtPosition(wordPosition) {
        // Clear existing highlights
        document.querySelectorAll('.word.cursor-highlight').forEach(el => {
            el.classList.remove('cursor-highlight');
        });
        
        // Find and highlight the word at the target position
        const targetWord = document.querySelector(`[data-word-index="${wordPosition}"]`);
        if (targetWord) {
            targetWord.classList.add('cursor-highlight');
            
            // Scroll to the word
            targetWord.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center',
                inline: 'nearest'
            });
            
            // Remove highlight after 2 seconds
            setTimeout(() => {
                targetWord.classList.remove('cursor-highlight');
            }, 2000);
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
        
        if (this.selectedRange.start === null || this.selectedRange.end === null) return;
        
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
    }

    updateSelectionStatus() {
        // Update UI to show current selection status for note context
        const hasSelection = this.selectedRange.start !== null && this.selectedRange.end !== null;
        
        if (hasSelection) {
            const wordCount = Math.abs(this.selectedRange.end - this.selectedRange.start) + 1;
            const startWord = Math.min(this.selectedRange.start, this.selectedRange.end);
            const endWord = Math.max(this.selectedRange.start, this.selectedRange.end);
            
            // Update note header placeholder to show context
            if (this.noteHeaderInput) {
                this.noteHeaderInput.placeholder = `Note about selection (${wordCount} words: ${startWord}-${endWord})`;
            }
        } else {
            // Reset to default placeholder
            if (this.noteHeaderInput) {
                this.noteHeaderInput.placeholder = 'e.g., Architecture Decisions, Action Items...';
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

        // Use selected range if available, otherwise use full transcript
        let startWordIndex = null;
        let endWordIndex = null;
        
        if (this.selectedRange.start !== null && this.selectedRange.end !== null) {
            startWordIndex = Math.min(this.selectedRange.start, this.selectedRange.end);
            endWordIndex = Math.max(this.selectedRange.start, this.selectedRange.end);
            
            // Show user feedback about selected context
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
        this.settings = {
            wordLimit: parseInt(this.wordLimitInput.value) || 0,
            readOnlyMode: this.readOnlyModeInput.checked,
            autoSave: this.autoSaveInput.checked,
            followTranscript: this.followTranscriptInput.checked
        };
        
        if (window.electronAPI) {
            window.electronAPI.updateSettings(this.settings);
        }
        
        this.hideSettings();
    }

    updateSettings(settings) {
        this.settings = { ...this.settings, ...settings };
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

