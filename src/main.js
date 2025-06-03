// Main process - Electron main process with TranscriptSummarizer integration

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Import the existing TranscriptSummarizer class
const { TranscriptSummarizer } = require('../transcript-summarizer');

class ElectronTranscriptApp {
    constructor() {
        this.mainWindow = null;
        this.summarizer = null;
        this.appSettings = {
            transcriptFile: '',
            screenshotsDir: '',
            windowState: {
                width: 1400,
                height: 900,
                x: undefined,
                y: undefined
            }
        };
        
        this.setupApp();
    }

    setupApp() {
        console.log('Setting up Electron app...');
        
        // App event handlers
        app.whenReady().then(() => {
            console.log('Electron app ready, creating window...');
            this.createWindow();
        });
        
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createWindow();
            }
        });

        // Setup IPC handlers
        this.setupIPC();
    }

    async createWindow() {
        console.log('createWindow called');
        
        // Load saved window state
        this.loadWindowState();
        console.log('Loaded settings:', this.appSettings);

        // Create the browser window
        this.mainWindow = new BrowserWindow({
            width: this.appSettings.windowState.width,
            height: this.appSettings.windowState.height,
            // Remove x,y positioning to let Electron center the window
            // x: this.appSettings.windowState.x,
            // y: this.appSettings.windowState.y,
            minWidth: 1000,
            minHeight: 700,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            },
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            show: false // Don't show until ready to prevent flicker
        });

        // Load the HTML file
        console.log('Loading HTML file from:', path.join(__dirname, 'index.html'));
        try {
            await this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
            console.log('HTML file loaded successfully');
        } catch (error) {
            console.error('Failed to load HTML file:', error);
            return;
        }

        // Add timeout fallback to show window even if ready-to-show doesn't fire
        setTimeout(() => {
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('Window not shown after 3s, forcing show...');
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        }, 3000);

        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            console.log('Window ready to show (but waiting for renderer to signal ready)');
            
            // Show file selection dialog if no transcript file is set
            if (!this.appSettings.transcriptFile) {
                console.log('No transcript file set, showing file selection dialog');
                this.mainWindow.show();
                this.mainWindow.focus();
                this.showFileSelectionDialog();
            }
            // If transcript file exists, wait for renderer to be ready before showing
        });

        // Add error handling for renderer process
        this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error('Failed to load renderer:', errorCode, errorDescription);
        });

        this.mainWindow.webContents.on('crashed', () => {
            console.error('Renderer process crashed');
        });

        // Save window state on move/resize
        this.mainWindow.on('moved', () => this.saveWindowState());
        this.mainWindow.on('resized', () => this.saveWindowState());

        // Handle window closed
        this.mainWindow.on('closed', () => {
            this.mainWindow = null;
            if (this.summarizer) {
                this.summarizer.stop();
            }
        });

        // Development tools
        if (process.env.NODE_ENV === 'development') {
            this.mainWindow.webContents.openDevTools();
        }
    }

    async showFileSelectionDialog() {
        const result = await dialog.showOpenDialog(this.mainWindow, {
            title: 'Select Transcript File',
            properties: ['openFile'],
            filters: [
                { name: 'Text Files', extensions: ['txt', 'log'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!result.canceled && result.filePaths.length > 0) {
            this.appSettings.transcriptFile = result.filePaths[0];
            
            // Ask for screenshots directory
            const screenshotResult = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Screenshots Directory (Optional)',
                properties: ['openDirectory']
            });

            if (!screenshotResult.canceled && screenshotResult.filePaths.length > 0) {
                this.appSettings.screenshotsDir = screenshotResult.filePaths[0];
            }

            this.saveSettings();
            this.initializeSummarizer();
        } else {
            // User canceled, close app
            app.quit();
        }
    }

    initializeSummarizer() {
        console.log('initializeSummarizer called');
        console.log('Transcript file:', this.appSettings.transcriptFile);
        
        if (!this.appSettings.transcriptFile || !fs.existsSync(this.appSettings.transcriptFile)) {
            console.error('Transcript file not found:', this.appSettings.transcriptFile);
            dialog.showErrorBox('Error', 'Transcript file not found or not selected.');
            return;
        }

        try {
            console.log('Creating ElectronTranscriptSummarizer...');
            // Create modified TranscriptSummarizer for Electron
            this.summarizer = new ElectronTranscriptSummarizer(
                this.appSettings.transcriptFile,
                this.appSettings.screenshotsDir,
                this
            );

            console.log('Starting summarizer...');
            this.summarizer.start();
            
            // Send initial data to renderer
            console.log('Sending initial data to renderer...');
            this.sendToRenderer('status-update', { connected: true });
            this.sendScreenshotsUpdate();
            this.sendAppDataUpdate();
            
            // Send existing transcript content
            this.sendExistingTranscriptContent();
            
        } catch (error) {
            console.error('Error initializing summarizer:', error);
            dialog.showErrorBox('Error', `Failed to initialize transcript monitoring: ${error.message}`);
        }
    }

    setupIPC() {
        // File operations
        ipcMain.handle('select-transcript-file', async () => {
            const result = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Transcript File',
                properties: ['openFile'],
                filters: [
                    { name: 'Text Files', extensions: ['txt', 'log'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            
            if (!result.canceled && result.filePaths.length > 0) {
                this.appSettings.transcriptFile = result.filePaths[0];
                this.saveSettings();
                return result.filePaths[0];
            }
            return null;
        });

        ipcMain.handle('select-screenshots-dir', async () => {
            const result = await dialog.showOpenDialog(this.mainWindow, {
                title: 'Select Screenshots Directory',
                properties: ['openDirectory']
            });
            
            if (!result.canceled && result.filePaths.length > 0) {
                this.appSettings.screenshotsDir = result.filePaths[0];
                this.saveSettings();
                return result.filePaths[0];
            }
            return null;
        });

        // Summarizer operations
        ipcMain.handle('create-summary', async (_, sessionContext) => {
            if (this.summarizer) {
                return await this.summarizer.createSummaryFromCurrent();
            }
        });

        ipcMain.handle('generate-note', async (_, noteData) => {
            if (this.summarizer) {
                const { header, mode, selectedScreenshots, sessionContext } = noteData;
                
                // Update summarizer's selected screenshots
                this.summarizer.selectedScreenshots = selectedScreenshots;
                
                // Update session context if provided
                if (sessionContext) {
                    this.summarizer.sessionContext = sessionContext;
                }

                switch (mode) {
                    case 'text-only':
                        return await this.summarizer.createNote(header, true);
                    case 'screenshots-only':
                        return await this.summarizer.createNoteFromScreenshotsOnly(header);
                    default:
                        return await this.summarizer.createNote(header);
                }
            }
        });

        ipcMain.handle('update-screenshot-selection', (_, selectedPaths) => {
            if (this.summarizer) {
                this.summarizer.selectedScreenshots = selectedPaths;
            }
        });

        ipcMain.handle('set-screenshot-filter', (_, filter) => {
            // Update screenshot list based on filter
            this.sendScreenshotsUpdate(filter);
        });

        ipcMain.handle('update-settings', (_, settings) => {
            if (this.summarizer) {
                this.summarizer.contextWordLimit = settings.wordLimit || 0;
                this.summarizer.readOnlyMode = settings.readOnlyMode;
                // Apply other settings...
            }
        });

        ipcMain.handle('save-notes', async (_, content) => {
            if (this.summarizer) {
                const notesPath = this.summarizer.notesFilePath;
                try {
                    // Convert HTML to markdown or plain text
                    const textContent = this.htmlToMarkdown(content);
                    fs.writeFileSync(notesPath, textContent, 'utf8');
                    return true;
                } catch (error) {
                    console.error('Error saving notes:', error);
                    return false;
                }
            }
        });

        ipcMain.handle('export-notes', async () => {
            if (this.summarizer) {
                const result = await dialog.showSaveDialog(this.mainWindow, {
                    title: 'Export Notes',
                    defaultPath: 'meeting-notes.md',
                    filters: [
                        { name: 'Markdown', extensions: ['md'] },
                        { name: 'Text', extensions: ['txt'] },
                        { name: 'HTML', extensions: ['html'] }
                    ]
                });

                if (!result.canceled) {
                    try {
                        const notes = fs.readFileSync(this.summarizer.notesFilePath, 'utf8');
                        fs.writeFileSync(result.filePath, notes, 'utf8');
                        return true;
                    } catch (error) {
                        dialog.showErrorBox('Export Error', error.message);
                        return false;
                    }
                }
            }
            return false;
        });

        ipcMain.handle('seek-timeline', (_, position) => {
            // Handle timeline seeking - could adjust the file reading position
            console.log('Seeking to position:', position);
        });

        ipcMain.handle('select-timeline-range', (_, startPercent, endPercent) => {
            // Handle timeline range selection
            console.log('Selected range:', startPercent, 'to', endPercent);
        });

        ipcMain.handle('update-session-context', (_, context) => {
            if (this.summarizer) {
                this.summarizer.sessionContext = context;
            }
        });

        ipcMain.handle('load-notes', async () => {
            if (this.summarizer) {
                try {
                    if (fs.existsSync(this.summarizer.notesFilePath)) {
                        const notesContent = fs.readFileSync(this.summarizer.notesFilePath, 'utf8');
                        return this.markdownToHtml(notesContent);
                    }
                    return '';
                } catch (error) {
                    console.error('Error loading notes:', error);
                    return '';
                }
            }
            return '';
        });

        // Menu and external links
        ipcMain.handle('open-external', (_, url) => {
            shell.openExternal(url);
        });

        // Renderer ready signal
        ipcMain.handle('renderer-ready', () => {
            console.log('Renderer process ready');
            if (this.mainWindow && !this.mainWindow.isVisible()) {
                console.log('Showing window now that renderer is ready');
                this.mainWindow.show();
                this.mainWindow.focus();
                
                // Initialize summarizer now that UI is ready
                if (this.appSettings.transcriptFile) {
                    this.initializeSummarizer();
                }
            }
        });
    }

    sendToRenderer(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }

    sendTranscriptUpdate(lines, wordCount, currentPosition) {
        this.sendToRenderer('transcript-update', {
            lines,
            wordCount,
            currentPosition
        });
    }

    sendScreenshotsUpdate(filter = 'session') {
        if (!this.summarizer) return;

        const screenshots = filter === 'session' 
            ? this.summarizer.getScreenshotFiles(true)
            : this.summarizer.getScreenshotFiles(false);

        const screenshotData = screenshots.map(path => ({
            path,
            filename: path.split('/').pop(),
            selected: this.summarizer.selectedScreenshots.includes(path)
        }));

        this.sendToRenderer('screenshots-update', screenshotData);
    }

    sendNoteCreated(noteData) {
        this.sendToRenderer('note-created', noteData);
    }

    sendSummaryUpdate(summary) {
        this.sendToRenderer('summary-update', summary);
    }

    sendCostUpdate(costData) {
        this.sendToRenderer('cost-update', costData);
    }

    sendAppDataUpdate() {
        const transcriptFilename = this.appSettings.transcriptFile 
            ? path.basename(this.appSettings.transcriptFile, path.extname(this.appSettings.transcriptFile))
            : '';
        
        this.sendToRenderer('app-data-update', {
            transcriptFilename,
            transcriptPath: this.appSettings.transcriptFile,
            screenshotsDir: this.appSettings.screenshotsDir
        });
    }

    sendExistingTranscriptContent() {
        if (!this.summarizer) return;
        
        try {
            console.log('Loading existing transcript content...');
            const lines = this.summarizer.parseTranscriptToLines();
            const wordCount = this.summarizer.getWordCount();
            const currentPosition = this.summarizer.lastPosition;
            
            console.log(`Sending ${lines.length} transcript lines to renderer`);
            
            this.sendTranscriptUpdate(lines, wordCount, currentPosition);
        } catch (error) {
            console.error('Error sending existing transcript content:', error);
        }
    }

    markdownToHtml(markdown) {
        // Enhanced Markdown to HTML conversion for WYSIWYG editing
        let html = markdown;
        
        // Escape HTML entities first
        html = html
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // Process headings
        html = html
            .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>');
        
        // Process inline formatting (bold and italic)
        html = html
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>');
        
        // Split into blocks for better list processing
        const blocks = html.split(/\n\s*\n/);
        const processedBlocks = blocks.map(block => {
            const lines = block.split('\n');
            
            // Check if this block contains bullet list items
            if (lines.some(line => line.match(/^- .+/))) {
                const listItems = lines
                    .filter(line => line.match(/^- .+/))
                    .map(line => line.replace(/^- (.+)/, '<li>$1</li>'))
                    .join('');
                const nonListLines = lines
                    .filter(line => !line.match(/^- .+/) && line.trim())
                    .join('<br>');
                
                return (nonListLines ? `<p>${nonListLines}</p>` : '') + 
                       (listItems ? `<ul>${listItems}</ul>` : '');
            }
            
            // Check if this block contains numbered list items
            else if (lines.some(line => line.match(/^\d+\. .+/))) {
                const listItems = lines
                    .filter(line => line.match(/^\d+\. .+/))
                    .map(line => line.replace(/^\d+\. (.+)/, '<li>$1</li>'))
                    .join('');
                const nonListLines = lines
                    .filter(line => !line.match(/^\d+\. .+/) && line.trim())
                    .join('<br>');
                
                return (nonListLines ? `<p>${nonListLines}</p>` : '') + 
                       (listItems ? `<ol>${listItems}</ol>` : '');
            }
            
            // Regular paragraph or heading
            else {
                const content = lines.join('<br>').trim();
                if (content.match(/^<h[1-6]>/)) {
                    return content; // Already a heading
                } else if (content) {
                    return `<p>${content}</p>`;
                }
                return '';
            }
        });
        
        return processedBlocks.filter(block => block).join('');
    }

    htmlToMarkdown(html) {
        // Enhanced HTML to Markdown conversion with proper list handling
        let markdown = html;
        
        // Convert headings
        markdown = markdown
            .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
            .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
            .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
            .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
        
        // Convert inline formatting
        markdown = markdown
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
        
        // Convert unordered lists
        markdown = markdown
            .replace(/<ul[^>]*>(.*?)<\/ul>/gis, (match, content) => {
                const items = content.match(/<li[^>]*>(.*?)<\/li>/gi) || [];
                return items.map(item => 
                    item.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1')
                ).join('\n') + '\n\n';
            });
        
        // Convert ordered lists
        markdown = markdown
            .replace(/<ol[^>]*>(.*?)<\/ol>/gis, (match, content) => {
                const items = content.match(/<li[^>]*>(.*?)<\/li>/gi) || [];
                return items.map((item, index) => 
                    item.replace(/<li[^>]*>(.*?)<\/li>/gi, `${index + 1}. $1`)
                ).join('\n') + '\n\n';
            });
        
        // Convert paragraphs and other elements
        markdown = markdown
            .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
            .replace(/<div[^>]*>(.*?)<\/div>/gi, '$1\n')
            .replace(/<br[^>]*>/gi, '\n');
        
        // Remove any remaining HTML tags
        markdown = markdown.replace(/<[^>]*>/g, '');
        
        // Decode HTML entities
        markdown = markdown
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        
        // Clean up extra whitespace
        markdown = markdown
            .replace(/\n\s*\n\s*\n/g, '\n\n') // Normalize multiple line breaks
            .replace(/^\s+|\s+$/g, '') // Trim start and end
            .trim();
        
        return markdown;
    }

    loadWindowState() {
        try {
            const settingsPath = path.join(__dirname, '..', 'app-settings.json');
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                this.appSettings = { ...this.appSettings, ...settings };
            }
        } catch (error) {
            console.log('Could not load settings:', error.message);
        }
    }

    saveWindowState() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const bounds = this.mainWindow.getBounds();
            this.appSettings.windowState = {
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y
            };
            this.saveSettings();
        }
    }

    saveSettings() {
        try {
            const settingsPath = path.join(__dirname, '..', 'app-settings.json');
            fs.writeFileSync(settingsPath, JSON.stringify(this.appSettings, null, 2), 'utf8');
        } catch (error) {
            console.log('Could not save settings:', error.message);
        }
    }
}

// Extended TranscriptSummarizer for Electron integration
class ElectronTranscriptSummarizer extends TranscriptSummarizer {
    constructor(filePath, screenshotsDir, electronApp) {
        super(filePath, screenshotsDir);
        this.electronApp = electronApp;
        this.sessionContext = '';
    }

    // Override console.log methods to send to renderer instead
    log(...args) {
        console.log(...args); // Keep for debugging
        // Could send log messages to renderer UI
    }

    // Override the processNewContent method to send updates to UI
    async processNewContent() {
        const result = await super.processNewContent();
        
        // Send transcript update to renderer
        if (this.electronApp) {
            const lines = this.parseTranscriptToLines();
            this.electronApp.sendTranscriptUpdate(
                lines,
                this.getWordCount(),
                this.lastPosition
            );
        }
        
        return result;
    }

    parseTranscriptToLines() {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            console.log('Transcript content length:', content.length);
            
            // First check if this is already line-separated (time range format)
            const initialLines = content.split('\n').filter(line => line.trim());
            const hasTimeRangeFormat = initialLines.some(line => 
                line.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/)
            );
            
            let lines;
            
            if (hasTimeRangeFormat) {
                // Time range format is already separated by lines
                lines = initialLines;
                console.log('Detected time range format, using existing line breaks');
            } else {
                // Split by timestamp markers [XX:XX:XX.XX] to handle single-line transcripts
                const timestampPattern = /(\[\d{2}:\d{2}:\d{2}\.\d{2}\]:?)/g;
                const segments = content.split(timestampPattern).filter(segment => segment.trim());
                
                console.log('Total segments after splitting by timestamps:', segments.length);
                
                // Reconstruct lines by combining timestamp + content pairs
                lines = [];
                for (let i = 0; i < segments.length - 1; i += 2) {
                    if (segments[i].match(timestampPattern) && segments[i + 1]) {
                        lines.push(segments[i] + segments[i + 1]);
                    }
                }
            }
            
            console.log('Reconstructed lines:', lines.length);
            
            if (lines.length > 0) {
                console.log('First line example:', lines[0].substring(0, 100) + '...');
                console.log('Parsed first line:', this.parseTranscriptLine(lines[0]));
            }
            
            const parsedLines = lines.map(line => {
                const parsed = this.parseTranscriptLine(line.trim());
                if (parsed) {
                    return {
                        timestamp: parsed.timestamp,
                        speaker: parsed.speaker,
                        content: parsed.content
                    };
                }
                return null;
            }).filter(Boolean);
            
            console.log('Successfully parsed lines:', parsedLines.length);
            return parsedLines;
        } catch (error) {
            console.error('Error parsing transcript lines:', error);
            return [];
        }
    }

    getWordCount() {
        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            return content.trim().split(/\s+/).length;
        } catch (error) {
            return 0;
        }
    }

    // Override note creation to send updates to UI
    async createNote(noteRequest, forceTextOnly = false) {
        const result = await super.createNote(noteRequest, forceTextOnly);
        
        if (this.electronApp) {
            // Send note created event
            this.electronApp.sendNoteCreated({
                content: result || noteRequest,
                position: this.lastPosition,
                id: Date.now().toString()
            });
        }
        
        return result;
    }

    // Override cost reporting to send to UI
    displayCostReport(requestCost, inputTokens, outputTokens) {
        super.displayCostReport(requestCost, inputTokens, outputTokens);
        
        if (this.electronApp) {
            this.electronApp.sendCostUpdate({
                request: requestCost,
                total: this.totalCost,
                tokens: {
                    input: inputTokens,
                    output: outputTokens,
                    totalInput: this.totalInputTokens,
                    totalOutput: this.totalOutputTokens
                }
            });
        }
    }

    // Override summary updates
    async updateSummary(newContent) {
        const result = await super.updateSummary(newContent);
        
        if (this.electronApp) {
            this.electronApp.sendSummaryUpdate(this.currentSummary);
        }
        
        return result;
    }
}

// Create and start the app
new ElectronTranscriptApp();

// Export for require
module.exports = { ElectronTranscriptApp, ElectronTranscriptSummarizer };