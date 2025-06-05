const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

class TranscriptSummarizer {
    constructor(filePath, screenshotsDir = null) {
        this.filePath = filePath;
        this.screenshotsDir = screenshotsDir;
        this.summaryFilePath = this.getSummaryFilePath(filePath);
        this.notesFilePath = this.getNotesFilePath(filePath);
        this.compactedFilePath = this.getCompactedFilePath(filePath);
        this.metadataFilePath = this.getMetadataFilePath(filePath);
        this.lastPosition = 0;
        this.currentSummary = '';
        this.pendingContent = '';
        this.readOnlyMode = true; // Start in read-only mode
        this.wordThreshold = 200;
        this.maxSummaryTokens = 4000; // Closer to 8192 output limit for richer summaries
        this.maxContextTokens = 150000; // Better utilize Claude 4 Sonnet's 200K input capacity
        this.contextUsage = 0;
        this.compressedTranscript = null; // Compressed version for context management
        this.useCompressed = false; // Whether to use compressed version for operations
        // Control now comes from desktop app UI, no need for voice control
        this.startTime = Date.now();
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        this.totalCost = 0;
        this.requestCount = 0;
        this.PRICING = {
            input: 0.003,   // $3 per 1M tokens = $0.003 per 1K tokens
            output: 0.015   // $15 per 1M tokens = $0.015 per 1K tokens
        };
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
        this.rl = null;
        this.selectedScreenshots = []; // User-selected screenshots for context
        this.screenshotPageSize = 20; // Screenshots per page
        this.currentScreenshotPage = 0; // Current page for screenshot menu
        this.contextWordLimit = 0; // Word limit for ASK/NOTE commands (0 = no limit)
        
        // Metadata and segmentation
        this.metadata = {
            transcriptFile: path.basename(filePath),
            segments: [],
            lastModified: new Date().toISOString(),
            version: "1.0"
        };
        this.lastKnownWordCount = 0; // Track word count for delta detection
    }

    getSummaryFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_summary.md`);
    }

    getNotesFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_notes.md`);
    }

    getCompactedFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_compacted.txt`);
    }

    getMetadataFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}.meta.json`);
    }

    loadMetadata() {
        try {
            if (fs.existsSync(this.metadataFilePath)) {
                const metadataContent = fs.readFileSync(this.metadataFilePath, 'utf8');
                this.metadata = JSON.parse(metadataContent);
                console.log(`Loaded metadata with ${this.metadata.segments.length} segments`);
            } else {
                console.log('No existing metadata file found, starting fresh');
                // Initialize with empty metadata structure
                this.metadata = {
                    transcriptFile: path.basename(this.filePath),
                    segments: [],
                    lastModified: new Date().toISOString(),
                    version: "1.0"
                };
            }
        } catch (error) {
            console.error('Error loading metadata:', error);
            // Fallback to empty metadata
            this.metadata = {
                transcriptFile: path.basename(this.filePath),
                segments: [],
                lastModified: new Date().toISOString(),
                version: "1.0"
            };
        }
    }

    saveMetadata() {
        try {
            this.metadata.lastModified = new Date().toISOString();
            const metadataJson = JSON.stringify(this.metadata, null, 2);
            fs.writeFileSync(this.metadataFilePath, metadataJson, 'utf8');
            console.log('Metadata saved successfully');
        } catch (error) {
            console.error('Error saving metadata:', error);
        }
    }

    addSegment(startWordIndex, endWordIndex, source = 'unknown') {
        const segmentId = `segment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const segment = {
            id: segmentId,
            startWordIndex,
            endWordIndex,
            timestamp: new Date().toISOString(),
            source
        };
        
        this.metadata.segments.push(segment);
        this.saveMetadata();
        
        console.log(`Added segment: ${segmentId} (${startWordIndex}-${endWordIndex}, source: ${source})`);
        return segment;
    }

    initializeWordCount() {
        try {
            // Read the entire current transcript to count words
            const currentContent = fs.readFileSync(this.filePath, 'utf8');
            const words = currentContent.split(/\s+/).filter(word => word.length > 0);
            this.lastKnownWordCount = words.length;
            
            console.log(`Initialized word count: ${this.lastKnownWordCount} words`);
            
            // If we don't have any segments yet and the file has content, create an initial segment
            if (this.metadata.segments.length === 0 && words.length > 0) {
                this.addSegment(0, words.length - 1, 'initial-load');
                console.log('Created initial segment for existing transcript content');
            }
        } catch (error) {
            console.error('Error initializing word count:', error);
            this.lastKnownWordCount = 0;
        }
    }

    loadExistingSummary() {
        if (fs.existsSync(this.summaryFilePath)) {
            this.currentSummary = fs.readFileSync(this.summaryFilePath, 'utf8').trim();
            console.log(`📋 Loaded existing summary from: ${this.summaryFilePath}`);
            return true;
        } else {
            // Create blank summary file
            fs.writeFileSync(this.summaryFilePath, '', 'utf8');
            console.log(`📄 Created blank summary file: ${this.summaryFilePath}`);
            return false;
        }
    }

    loadOrCreateNotesFile() {
        if (!fs.existsSync(this.notesFilePath)) {
            // Create formatted notes file with header
            const transcriptBasename = path.basename(this.filePath, path.extname(this.filePath));
            const today = new Date().toISOString().split('T')[0]; // yyyy-mm-dd format
            
            const initialContent = `# ${transcriptBasename} - ${today}\n\n`;
            
            fs.writeFileSync(this.notesFilePath, initialContent, 'utf8');
            console.log(`📝 Created formatted notes file: ${this.notesFilePath}`);
        } else {
            console.log(`📝 Notes file available: ${this.notesFilePath}`);
        }
        
        if (this.screenshotsDir) {
            if (fs.existsSync(this.screenshotsDir)) {
                const screenshots = this.getScreenshotFiles();
                const sessionScreenshots = this.getScreenshotFiles(true);
                console.log(`📸 Screenshots directory available: ${this.screenshotsDir}`);
                if (screenshots.length > 0) {
                    console.log(`📸 Found ${screenshots.length} total screenshot(s), ${sessionScreenshots.length} from current session`);
                    console.log(`📸 Use SCREENSHOTS or SESSION commands to select which to include`);
                } else {
                    console.log(`📸 No screenshots found in directory`);
                }
            } else {
                console.log(`⚠️  Screenshots directory not found: ${this.screenshotsDir}`);
            }
        }
    }

    getScreenshotFiles(sessionOnly = false) {
        if (!this.screenshotsDir || !fs.existsSync(this.screenshotsDir)) {
            return [];
        }
        
        try {
            const files = fs.readdirSync(this.screenshotsDir);
            let screenshots = files
                .filter(file => /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(file))
                .map(file => path.join(this.screenshotsDir, file));

            if (sessionOnly) {
                // Filter screenshots created/modified during this session
                screenshots = screenshots.filter(screenshot => {
                    try {
                        const stats = fs.statSync(screenshot);
                        // Use the later of creation time or modification time
                        const fileTime = Math.max(stats.birthtime.getTime(), stats.mtime.getTime());
                        return fileTime >= this.startTime;
                    } catch (error) {
                        // If we can't get file stats, exclude it from session filter
                        return false;
                    }
                });
            }

            // Sort by modification time (latest first), then by filename if times are equal
            return screenshots.sort((a, b) => {
                try {
                    const statsA = fs.statSync(a);
                    const statsB = fs.statSync(b);
                    const timeA = Math.max(statsA.birthtime.getTime(), statsA.mtime.getTime());
                    const timeB = Math.max(statsB.birthtime.getTime(), statsB.mtime.getTime());
                    
                    // Latest first (descending order)
                    if (timeA !== timeB) {
                        return timeB - timeA;
                    }
                    
                    // If times are equal, sort by filename
                    return path.basename(a).localeCompare(path.basename(b));
                } catch (error) {
                    // If we can't get file stats, fall back to filename sort
                    return path.basename(a).localeCompare(path.basename(b));
                }
            });
        } catch (error) {
            console.log('⚠️  Error reading screenshots directory:', error.message);
            return [];
        }
    }

    // Include all the rest of the methods from the original class
    // For brevity, I'll include the key methods that the Electron app needs

    parseTranscriptLine(line) {
        // Parse format: [00:42:55.55] Juho: Message content (original format)
        const timestampMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{2})\]\s*([^:]+):\s*(.+)$/);
        if (timestampMatch) {
            return {
                timestamp: timestampMatch[1],
                speaker: timestampMatch[2].trim(),
                content: timestampMatch[3].trim()
            };
        }
        
        // Parse format: [00:00:00.16]: content (Teams/single timestamp format)
        const timestampWithColonMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{2})\]:\s*(.+)$/);
        if (timestampWithColonMatch) {
            return {
                timestamp: timestampWithColonMatch[1],
                speaker: 'Transcript',
                content: timestampWithColonMatch[2].trim()
            };
        }
        
        // Parse format: [00:00:00.000 --> 00:00:01.760]   Content (time range format)
        const timeRangeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.+)$/);
        if (timeRangeMatch) {
            return {
                timestamp: timeRangeMatch[1], // Use start timestamp
                speaker: 'Speaker',
                content: timeRangeMatch[3].trim()
            };
        }
        
        return null;
    }

    calculateCost(inputTokens, outputTokens) {
        const inputCost = (inputTokens / 1000) * this.PRICING.input;
        const outputCost = (outputTokens / 1000) * this.PRICING.output;
        return inputCost + outputCost;
    }

    displayCostReport(requestCost, inputTokens, outputTokens) {
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.totalCost += requestCost;
        this.requestCount += 1;

        const runtimeHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        const estimatedHourlyCost = runtimeHours > 0 ? this.totalCost / runtimeHours : 0;

        console.log('\n💰 Cost Report:');
        console.log('─'.repeat(50));
        console.log(`📊 This request: ${inputTokens} in + ${outputTokens} out = $${requestCost.toFixed(4)}`);
        console.log(`📈 Cumulative: ${this.totalInputTokens} in + ${this.totalOutputTokens} out = $${this.totalCost.toFixed(4)}`);
        console.log(`⏱️  Runtime: ${(runtimeHours * 60).toFixed(1)} minutes | Requests: ${this.requestCount}`);
        console.log(`💵 Estimated hourly cost: $${estimatedHourlyCost.toFixed(2)}/hour`);
        console.log('─'.repeat(50));
    }

    saveSummary() {
        fs.writeFileSync(this.summaryFilePath, this.currentSummary, 'utf8');
    }

    saveNote(note, startWordIndex = null, endWordIndex = null, noteHeader = null) {
        const now = new Date();
        const timestamp = now.getFullYear() + '-' + 
                         String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                         String(now.getDate()).padStart(2, '0') + ' ' + 
                         String(now.getHours()).padStart(2, '0') + ':' + 
                         String(now.getMinutes()).padStart(2, '0') + ':' + 
                         String(now.getSeconds()).padStart(2, '0');
        
        // Create H2 header with word indices if provided
        let noteEntry = '';
        if (noteHeader) {
            noteEntry += `## ${noteHeader}`;
            if (startWordIndex !== null && endWordIndex !== null) {
                noteEntry += ` <!-- words:${startWordIndex}-${endWordIndex} -->`;
            }
            noteEntry += `\n\n${note}\n\n`;
        } else {
            // Legacy format for backward compatibility
            noteEntry = `[${timestamp}] ${note}\n\n`;
        }
        
        fs.appendFileSync(this.notesFilePath, noteEntry, 'utf8');
    }

    async createNote(noteRequest, forceTextOnly = false, startWordIndex = null, endWordIndex = null) {
        try {
            // Get the active transcript (compressed if available)
            const fullTranscript = this.getActiveTranscript();
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content available for note context');
                return;
            }

            // Use selected word range if provided, otherwise use full transcript or apply word limit
            let contextTranscript = fullTranscript;
            let actualStartWordIndex = startWordIndex;
            let actualEndWordIndex = endWordIndex;
            
            if (startWordIndex !== null && endWordIndex !== null) {
                contextTranscript = this.extractWordRange(fullTranscript, startWordIndex, endWordIndex);
                console.log(`Using selected word range ${startWordIndex}-${endWordIndex} for note context`);
            } else if (this.contextWordLimit > 0) {
                // Apply context limit and calculate word range indices
                const words = fullTranscript.trim().split(/\s+/);
                const totalWords = words.length;
                
                if (totalWords > this.contextWordLimit) {
                    // Calculate range: last_word - limit as start, last_word as end
                    actualStartWordIndex = totalWords - this.contextWordLimit;
                    actualEndWordIndex = totalWords - 1;
                    contextTranscript = this.getLimitedTranscript(fullTranscript);
                    console.log(`Using word limit ${this.contextWordLimit}, calculated range ${actualStartWordIndex}-${actualEndWordIndex} for note context`);
                } else {
                    // If total words is less than limit, use the full transcript with proper indices
                    actualStartWordIndex = 0;
                    actualEndWordIndex = totalWords - 1;
                    contextTranscript = fullTranscript;
                    console.log(`Full transcript is within word limit, using range 0-${actualEndWordIndex} for note context`);
                }
            } else {
                contextTranscript = fullTranscript;
                console.log('Using full transcript for note context');
            }

            const messages = [];

            let promptText = `You are an AI assistant helping create concise meeting notes for a SOFTWARE SOLUTION ARCHITECT. You have access to the meeting transcript and are asked to create a brief note about a specific topic.

MEETING TRANSCRIPT:
${contextTranscript}

NOTE REQUEST:
${noteRequest}

INSTRUCTIONS:
- Create a brief, focused note (2-8 sentences and a list of bullet points depending on the need) based on the request and transcript content
- Include only the most relevant details from the transcript related to the request
- Use a conversational, note-taking style rather than formal documentation
- If the topic isn't discussed in the transcript, state that clearly
- Keep it concise - this is a quick note, not a full analysis
- IMPORTANT: Write the note in the same language as the note request - if the request is in Finnish, respond in Finnish; if in English, respond in English
- DO NOT include any headers, titles, or formatting - just provide the note content as the header will be added automatically

Brief note content:`;

            // Add text content
            const content = [{ type: 'text', text: promptText }];

            // Add selected screenshots (unless forced text-only)
            if (!forceTextOnly && this.selectedScreenshots.length > 0) {
                for (const screenshotPath of this.selectedScreenshots) {
                    try {
                        const imageData = fs.readFileSync(screenshotPath);
                        const base64Image = imageData.toString('base64');
                        const fileExtension = path.extname(screenshotPath).toLowerCase().substring(1);
                        const mimeType = fileExtension === 'jpg' ? 'jpeg' : fileExtension;
                        
                        content.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: `image/${mimeType}`,
                                data: base64Image
                            }
                        });
                    } catch (error) {
                        console.log(`⚠️  Could not read screenshot ${screenshotPath}:`, error.message);
                    }
                }
            }

            messages.push({ role: 'user', content });

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 800,
                messages
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const noteContent = message.content[0].text;
            this.saveNote(noteContent, actualStartWordIndex, actualEndWordIndex, noteRequest);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            return noteContent;

        } catch (error) {
            console.error('Error creating note:', error.message);
            return null;
        }
    }

    async createNoteFromScreenshotsOnly(noteRequest, startWordIndex = null, endWordIndex = null) {
        try {
            if (this.selectedScreenshots.length === 0) {
                console.log('⚠️  No screenshots selected for screenshot-only note');
                return;
            }

            // Calculate word range indices for note positioning even for screenshot-only notes
            let actualStartWordIndex = startWordIndex;
            let actualEndWordIndex = endWordIndex;
            
            if (startWordIndex === null || endWordIndex === null) {
                if (this.contextWordLimit > 0) {
                    // Apply context limit and calculate word range indices
                    const fullTranscript = this.getActiveTranscript();
                    const words = fullTranscript.trim().split(/\s+/);
                    const totalWords = words.length;
                    
                    if (totalWords > this.contextWordLimit) {
                        // Calculate range: last_word - limit as start, last_word as end
                        actualStartWordIndex = totalWords - this.contextWordLimit;
                        actualEndWordIndex = totalWords - 1;
                        console.log(`Screenshot-only note: using word limit ${this.contextWordLimit}, calculated range ${actualStartWordIndex}-${actualEndWordIndex}`);
                    } else {
                        // If total words is less than limit, use the full transcript with proper indices
                        actualStartWordIndex = 0;
                        actualEndWordIndex = totalWords - 1;
                        console.log(`Screenshot-only note: full transcript is within word limit, using range 0-${actualEndWordIndex}`);
                    }
                }
            }

            const messages = [];
            const content = [];

            // Add note request text
            content.push({
                type: 'text',
                text: `Create a brief note about: ${noteRequest}\n\nAnalyze the provided screenshots and create concise notes based on what you see. Focus on the specific topic requested. Provide a clear, actionable summary.\n\nIMPORTANT: Do NOT include any headers, titles, or formatting - just provide the note content as the header will be added automatically.`
            });

            // Add selected screenshots
            for (const screenshotPath of this.selectedScreenshots) {
                try {
                    const imageData = fs.readFileSync(screenshotPath);
                    const base64Image = imageData.toString('base64');
                    const fileExtension = path.extname(screenshotPath).toLowerCase().substring(1);
                    const mimeType = fileExtension === 'jpg' ? 'jpeg' : fileExtension;
                    
                    content.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: `image/${mimeType}`,
                            data: base64Image
                        }
                    });
                } catch (error) {
                    console.log(`⚠️  Could not read screenshot ${screenshotPath}:`, error.message);
                }
            }

            messages.push({ role: 'user', content });

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 800,
                messages
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const noteContent = message.content[0].text;
            this.saveNote(noteContent, actualStartWordIndex, actualEndWordIndex, noteRequest);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            return noteContent;

        } catch (error) {
            console.error('Error creating screenshot-only note:', error.message);
            return null;
        }
    }

    async createSummaryFromCurrent() {
        try {
            // Get the active transcript (compressed if available)
            const fullTranscript = this.getActiveTranscript();
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content found to summarize');
                return;
            }
            
            console.log(`📖 Processing transcript: ${fullTranscript.length} characters`);
            
            // Use full transcript content (no control instructions to filter)
            const cleanTranscript = fullTranscript.trim();
            
            if (!cleanTranscript) {
                console.log('⚠️  No transcript content found to summarize');
                return;
            }
            
            console.log(`📄 Using transcript: ${cleanTranscript.length} characters`);
            
            // Read existing notes for additional context
            let existingNotes = '';
            try {
                if (fs.existsSync(this.notesFilePath)) {
                    existingNotes = fs.readFileSync(this.notesFilePath, 'utf8').trim();
                }
            } catch (error) {
                console.log('⚠️  Could not read notes file for context');
            }
            
            // Clear pending content since we're processing everything
            this.pendingContent = '';
            
            if (this.currentSummary) {
                // Update existing summary
                await this.updateSummary(cleanTranscript);
            } else {
                // Create initial summary
                const prompt = `You are creating a technical meeting summary for a SOFTWARE SOLUTION ARCHITECT. This is the complete transcript content:

${cleanTranscript}

${existingNotes ? `SUPPLEMENTARY NOTES (for additional context):
${existingNotes}

` : ''}CRITICAL: ONLY SUMMARIZE WHAT WAS EXPLICITLY MENTIONED. DO NOT INVENT OR EXTRAPOLATE.

Create a summary that captures only the technical details explicitly mentioned in the transcript. Do not infer system architecture, expand on brief mentions, or add technical depth not discussed. Use exact terminology from speakers. Include a "Questions for Further Investigation" section only for topics that were mentioned but need clarification.

Be conservative - if technical details weren't explicitly discussed, don't include them.`;

                const message = await this.anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: prompt
                    }]
                });

                const inputTokens = message.usage.input_tokens;
                const outputTokens = message.usage.output_tokens;
                const requestCost = this.calculateCost(inputTokens, outputTokens);

                this.currentSummary = message.content[0].text;
                this.saveSummary();
                
                this.displayCostReport(requestCost, inputTokens, outputTokens);
                
                console.log('\n📋 Summary Created:');
                console.log('='.repeat(50));
                console.log(this.currentSummary);
                console.log('='.repeat(50));
                console.log(`💾 Summary saved to: ${this.summaryFilePath}`);
            }

        } catch (error) {
            console.error('Error creating summary from current transcript:', error.message);
        }
    }

    getActiveTranscript() {
        // Get the transcript to use for AI operations (compressed if available and active)
        if (this.useCompressed && this.compressedTranscript) {
            // Append any new content since compression to the compressed version
            return this.compressedTranscript + '\n' + this.pendingContent;
        } else {
            return fs.readFileSync(this.filePath, 'utf8');
        }
    }

    getLimitedTranscript(fullTranscript) {
        if (this.contextWordLimit === 0) {
            return fullTranscript; // No limit
        }

        const words = fullTranscript.trim().split(/\s+/);
        if (words.length <= this.contextWordLimit) {
            return fullTranscript; // Already within limit
        }

        // Take the last N words (tail)
        const limitedWords = words.slice(-this.contextWordLimit);
        return limitedWords.join(' ');
    }

    extractWordRange(fullTranscript, startWordIndex, endWordIndex) {
        // Extract specific word range from transcript
        const words = fullTranscript.trim().split(/\s+/);
        
        if (startWordIndex < 0 || endWordIndex >= words.length || startWordIndex > endWordIndex) {
            console.log(`⚠️  Invalid word range: ${startWordIndex}-${endWordIndex} (transcript has ${words.length} words)`);
            return fullTranscript; // Fallback to full transcript
        }

        const selectedWords = words.slice(startWordIndex, endWordIndex + 1);
        const extractedText = selectedWords.join(' ');
        
        console.log(`Extracted ${selectedWords.length} words from transcript for note context`);
        return extractedText;
    }

    // Add other essential methods as needed...
    async start() {
        console.log(`Monitoring transcript file: ${this.filePath}`);
        console.log(`Summary will be saved to: ${this.summaryFilePath}`);
        console.log(`Notes will be saved to: ${this.notesFilePath}`);
        
        if (!fs.existsSync(this.filePath)) {
            console.error(`File does not exist: ${this.filePath}`);
            throw new Error(`File does not exist: ${this.filePath}`);
        }

        this.loadExistingSummary();
        this.loadOrCreateNotesFile();
        this.loadMetadata();
        this.initializeWordCount();
        
        this.lastPosition = fs.statSync(this.filePath).size;
        console.log(`Starting from position: ${this.lastPosition}`);

        fs.watchFile(this.filePath, { interval: 1000 }, async (curr, prev) => {
            if (curr.mtime > prev.mtime) {
                await this.processNewContent();
            }
        });
    }

    async processNewContent() {
        try {
            const stats = fs.statSync(this.filePath);
            if (stats.size > this.lastPosition) {
                const stream = fs.createReadStream(this.filePath, {
                    start: this.lastPosition,
                    end: stats.size
                });

                let newContent = '';
                stream.on('data', (chunk) => {
                    newContent += chunk.toString();
                });

                stream.on('end', async () => {
                    const trimmedContent = newContent.trim();
                    
                    if (trimmedContent) {
                        console.log(`\n📝 New transcript content (${newContent.length} chars):`);
                        console.log(trimmedContent);
                        
                        // Calculate word indices for the new segment
                        const newWords = trimmedContent.split(/\s+/).filter(word => word.length > 0);
                        const startWordIndex = this.lastKnownWordCount;
                        const endWordIndex = this.lastKnownWordCount + newWords.length - 1;
                        
                        // Add segment for the new content
                        if (newWords.length > 0) {
                            this.addSegment(startWordIndex, endWordIndex, 'live-transcription');
                            this.lastKnownWordCount = endWordIndex + 1;
                        }
                        
                        this.pendingContent += ' ' + trimmedContent;
                        this.lastPosition = stats.size;
                    }
                });
            }
        } catch (error) {
            console.error('Error processing new content:', error.message);
        }
    }

    async updateSummary(newContent) {
        // Implementation of updateSummary method
        // This is a simplified version - include the full implementation as needed
        try {
            const prompt = this.currentSummary 
                ? `Update the existing summary with new content: ${newContent}`
                : `Create initial summary from: ${newContent}`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4000,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            this.currentSummary = message.content[0].text;
            this.saveSummary();
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);
            
        } catch (error) {
            console.error('Error updating summary:', error.message);
        }
    }

    async stop() {
        fs.unwatchFile(this.filePath);
        
        if (this.rl) {
            this.rl.close();
        }
        
        if (this.currentSummary) {
            this.saveSummary();
        }
    }
}

module.exports = { TranscriptSummarizer };