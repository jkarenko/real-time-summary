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
            headers: [],
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
                
                // Ensure backward compatibility - add headers array if missing
                if (!this.metadata.headers) {
                    this.metadata.headers = [];
                }
                
                // Ensure headers have all required fields for backward compatibility
                this.metadata.headers.forEach(header => {
                    if (!header.summary) {
                        header.summary = '';
                        console.log(`Added empty summary to existing header: "${header.title}"`);
                    }
                    if (header.locked === undefined) {
                        header.locked = header.segments ? header.segments.length >= 3 : false;
                        console.log(`Set locked status for existing header: "${header.title}" (${header.locked})`);
                    }
                    if (!header.subHeaders) {
                        header.subHeaders = [];
                        console.log(`Added subHeaders array to existing header: "${header.title}"`);
                    }
                });
                
                console.log(`Loaded metadata with ${this.metadata.segments.length} segments and ${this.metadata.headers.length} headers`);
            } else {
                console.log('No existing metadata file found, starting fresh');
                // Initialize with empty metadata structure
                this.metadata = {
                    transcriptFile: path.basename(this.filePath),
                    segments: [],
                    headers: [],
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
                headers: [],
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
        
        // Trigger automatic topic assignment for live transcription
        if (source === 'live-transcription') {
            this.processAutomaticTopicAssignment(segment);
        }
        
        return segment;
    }

    splitSegmentAtWordIndex(originalSegment, splitWordIndex) {
        console.log(`Splitting segment ${originalSegment.id} at word index ${splitWordIndex}`);
        
        // Validate split point
        if (splitWordIndex <= originalSegment.startWordIndex || splitWordIndex > originalSegment.endWordIndex) {
            console.error(`Invalid split point ${splitWordIndex} for segment ${originalSegment.startWordIndex}-${originalSegment.endWordIndex}`);
            return null;
        }
        
        // Create first segment (up to split point - 1)
        const firstSegment = {
            id: `${originalSegment.id}-part1`,
            startWordIndex: originalSegment.startWordIndex,
            endWordIndex: splitWordIndex - 1,
            timestamp: originalSegment.timestamp,
            source: originalSegment.source,
            splitFrom: originalSegment.id
        };
        
        // Create second segment (from split point onwards)
        const secondSegment = {
            id: `${originalSegment.id}-part2`,
            startWordIndex: splitWordIndex,
            endWordIndex: originalSegment.endWordIndex,
            timestamp: new Date().toISOString(), // New timestamp for the split
            source: originalSegment.source,
            splitFrom: originalSegment.id
        };
        
        console.log(`Split segment into: ${firstSegment.id} (${firstSegment.startWordIndex}-${firstSegment.endWordIndex}) and ${secondSegment.id} (${secondSegment.startWordIndex}-${secondSegment.endWordIndex})`);
        
        return { firstSegment, secondSegment };
    }

    updateMetadataAfterSplit(originalSegment, firstSegment, secondSegment, headerIdForFirstSegment, headerIdForSecondSegment) {
        try {
            // Remove original segment from metadata
            const originalSegmentIndex = this.metadata.segments.findIndex(s => s.id === originalSegment.id);
            if (originalSegmentIndex >= 0) {
                this.metadata.segments.splice(originalSegmentIndex, 1);
            }
            
            // Add new segments to metadata
            this.metadata.segments.push(firstSegment, secondSegment);
            
            // Update headers to reference the new segments
            this.metadata.headers.forEach(header => {
                // Remove original segment from all headers
                const segmentIndex = header.segments.indexOf(originalSegment.id);
                if (segmentIndex >= 0) {
                    header.segments.splice(segmentIndex, 1);
                    
                    // Add appropriate new segment
                    if (header.id === headerIdForFirstSegment) {
                        header.segments.push(firstSegment.id);
                    }
                    if (header.id === headerIdForSecondSegment) {
                        header.segments.push(secondSegment.id);
                    }
                }
                
                // Update sub-headers as well
                if (header.subHeaders) {
                    header.subHeaders.forEach(subHeader => {
                        const subSegmentIndex = subHeader.segments.indexOf(originalSegment.id);
                        if (subSegmentIndex >= 0) {
                            subHeader.segments.splice(subSegmentIndex, 1);
                            
                            // Add appropriate new segment to sub-header
                            if (header.id === headerIdForFirstSegment) {
                                subHeader.segments.push(firstSegment.id);
                            }
                            if (header.id === headerIdForSecondSegment) {
                                subHeader.segments.push(secondSegment.id);
                            }
                        }
                    });
                }
            });
            
            this.saveMetadata();
            console.log(`Updated metadata after splitting segment ${originalSegment.id}`);
            
        } catch (error) {
            console.error('Error updating metadata after segment split:', error);
        }
    }

    async initializeWordCount() {
        try {
            // Read the entire current transcript to count words
            const currentContent = fs.readFileSync(this.filePath, 'utf8');
            const words = currentContent.split(/\s+/).filter(word => word.length > 0);
            this.lastKnownWordCount = words.length;
            
            console.log(`Initialized word count: ${this.lastKnownWordCount} words`);
            
            // If we don't have any segments yet and the file has content, segment it into 30-word chunks
            if (this.metadata.segments.length === 0 && words.length > 0) {
                await this.segmentExistingContent(words);
            }
        } catch (error) {
            console.error('Error initializing word count:', error);
            this.lastKnownWordCount = 0;
        }
    }

    async segmentExistingContent(words) {
        console.log(`Segmenting existing content of ${words.length} words into 30-word chunks...`);
        
        const SEGMENT_SIZE = 50;
        let startWordIndex = 0;
        
        while (startWordIndex < words.length) {
            const endWordIndex = Math.min(startWordIndex + SEGMENT_SIZE - 1, words.length - 1);
            
            // Create segment (without triggering topic assignment yet)
            const segmentId = `segment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const segment = {
                id: segmentId,
                startWordIndex,
                endWordIndex,
                timestamp: new Date().toISOString(),
                source: 'initial-load'
            };
            
            this.metadata.segments.push(segment);
            console.log(`Created segment: ${segmentId} (${startWordIndex}-${endWordIndex}, ${endWordIndex - startWordIndex + 1} words)`);
            
            startWordIndex = endWordIndex + 1;
        }
        
        // Save metadata with all segments
        this.saveMetadata();
        
        console.log(`Created ${this.metadata.segments.length} segments from existing content`);
        
        // Now process each segment through topic assignment as if they were live
        await this.processExistingSegmentsForTopics();
    }

    async processExistingSegmentsForTopics() {
        console.log('Processing existing segments through automatic topic assignment...');
        
        for (let i = 0; i < this.metadata.segments.length; i++) {
            const segment = this.metadata.segments[i];
            
            console.log(`Processing segment ${i + 1}/${this.metadata.segments.length}: ${segment.id}`);
            
            try {
                // Process as if it's a new live segment
                await this.processAutomaticTopicAssignment(segment);
                
                // Add a small delay to avoid overwhelming the API
                if (i < this.metadata.segments.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                console.error(`Error processing segment ${segment.id}:`, error.message);
            }
        }
        
        console.log('Finished processing existing segments for topics');
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

    async generateHeader(startWordIndex = null, endWordIndex = null, contextType = null) {
        try {
            // Get the active transcript (compressed if available)
            const fullTranscript = this.getActiveTranscript();
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content available for header generation');
                return 'Meeting Topic';
            }

            // Use selected word range if provided, otherwise use full transcript or apply word limit
            let contextTranscript = fullTranscript;
            
            if (startWordIndex !== null && endWordIndex !== null) {
                contextTranscript = this.extractWordRange(fullTranscript, startWordIndex, endWordIndex);
                console.log(`Generating header from selected word range ${startWordIndex}-${endWordIndex}`);
            } else if (this.contextWordLimit > 0) {
                contextTranscript = this.getLimitedTranscript(fullTranscript);
                console.log(`Generating header from word-limited transcript (${this.contextWordLimit} words)`);
            } else {
                console.log('Generating header from full transcript');
            }

            const messages = [];
            const content = [];

            // Create prompt for header generation
            let promptText = `You are an AI assistant helping generate concise note headers for a SOFTWARE SOLUTION ARCHITECT. You have access to the meeting transcript and need to generate a brief, descriptive header that captures the main topic or theme of the content.

MEETING TRANSCRIPT:
${contextTranscript}`;

            // Add context about the selection type if available
            if (contextType) {
                promptText += `

CONTEXT TYPE: ${contextType}`;
            }

            promptText += `

Generate a concise header (3-8 words) that describes the main topic, decision, or discussion point from this content. The header should be:
- Clear and descriptive
- Professional and specific
- Suitable for a meeting note title
- Without quotes or special formatting

Examples of good headers:
- "Database Migration Strategy"
- "API Rate Limiting Implementation"
- "Security Review Findings"
- "Performance Optimization Plan"

CRITICAL: Respond with ONLY the header title. Do NOT include explanations, reasoning, line breaks, or additional text. Just the title.`;

            content.push({
                type: 'text',
                text: promptText
            });

            // Add selected screenshots if any
            if (this.selectedScreenshots && this.selectedScreenshots.length > 0) {
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
                max_tokens: 100,
                messages
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const rawHeaderContent = message.content[0].text.trim();
            const headerContent = this.cleanupHeaderText(rawHeaderContent);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            console.log(`Generated header: "${headerContent}"`);
            return headerContent;

        } catch (error) {
            console.error('Error generating header:', error.message);
            return 'Meeting Topic';
        }
    }

    cleanupHeaderText(text) {
        // Remove quotes if present
        let cleaned = text.replace(/^["']|["']$/g, '');
        
        // Take only the first line (in case there are line breaks)
        cleaned = cleaned.split('\n')[0];
        
        // Remove common prefixes that might appear
        cleaned = cleaned.replace(/^(Header:|Title:|Topic:)\s*/i, '');
        
        // Limit to reasonable length (max 60 characters)
        if (cleaned.length > 60) {
            // Try to find a good breaking point
            const words = cleaned.split(' ');
            let result = '';
            for (const word of words) {
                if ((result + ' ' + word).length > 60) break;
                result += (result ? ' ' : '') + word;
            }
            cleaned = result || cleaned.substring(0, 60);
        }
        
        return cleaned.trim();
    }

    async updateHeaderSummary(header, newSegmentContent) {
        try {
            const currentSummary = header.summary || '';
            const maxSummaryLength = 200; // Keep summaries reasonable length
            
            // If current summary is already quite long, compress it first
            if (currentSummary.length > maxSummaryLength) {
                header.summary = await this.compressSummary(currentSummary, newSegmentContent);
            } else {
                // Simply append the new content for now
                const combinedContent = currentSummary + ' ' + newSegmentContent;
                
                // If combined content is too long, compress it
                if (combinedContent.length > maxSummaryLength) {
                    header.summary = await this.compressSummary(currentSummary, newSegmentContent);
                } else {
                    header.summary = combinedContent.trim();
                }
            }
            
            console.log(`Updated header summary for "${header.title}" (${header.summary.length} chars)`);
            
        } catch (error) {
            console.error('Error updating header summary:', error.message);
            // Fallback: just append without compression
            header.summary = (header.summary || '') + ' ' + newSegmentContent;
        }
    }

    async compressSummary(currentSummary, newContent) {
        try {
            const prompt = `Compress this meeting discussion summary while retaining all key information:

CURRENT SUMMARY:
${currentSummary}

NEW CONTENT TO INTEGRATE:
${newContent}

Create a concise summary (max 400 words) that:
- Combines both the existing summary and new content
- Preserves all technical details, decisions, and important points
- Uses clear, professional language
- Focuses on actionable items and key findings

Provide ONLY the compressed summary, no explanations.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 600,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            return message.content[0].text.trim();
            
        } catch (error) {
            console.error('Error compressing summary:', error.message);
            // Fallback: truncate to reasonable length
            const combined = currentSummary + ' ' + newContent;
            return combined.length > 500 ? combined.substring(0, 500) + '...' : combined;
        }
    }

    // Automatic Topic Assignment Methods
    async processAutomaticTopicAssignment(segment) {
        try {
            // Check if this is the first segment
            const isFirstSegment = this.metadata.segments.length === 1;
            
            if (isFirstSegment) {
                await this.createFirstHeader(segment);
            } else {
                await this.assignSegmentToHeader(segment);
            }
        } catch (error) {
            console.error('Error in automatic topic assignment:', error.message);
        }
    }

    async createFirstHeader(segment) {
        try {
            console.log('Creating first automatic header for segment:', segment.id);
            
            // Generate header for the first segment
            const headerTitle = await this.generateHeader(segment.startWordIndex, segment.endWordIndex, 'segment');
            
            // Create initial summary for the header
            const initialSummary = this.getSegmentContent(segment);
            
            // Create header metadata entry
            const headerId = `header-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const header = {
                id: headerId,
                title: headerTitle,
                segments: [segment.id],
                summary: initialSummary,
                locked: false,
                subHeaders: [],
                timestamp: new Date().toISOString()
            };
            
            this.metadata.headers.push(header);
            this.saveMetadata();
            
            console.log(`Created first header: "${headerTitle}" for segment ${segment.id}`);
            
            // Notify electron app if available
            if (this.electronApp) {
                this.electronApp.sendTopicUpdate({
                    type: 'header-created',
                    header: header,
                    segment: segment
                });
            }
            
        } catch (error) {
            console.error('Error creating first header:', error.message);
        }
    }

    async assignSegmentToHeader(segment) {
        try {
            // Ensure headers array exists
            if (!this.metadata.headers) {
                this.metadata.headers = [];
            }
            
            if (this.metadata.headers.length === 0) {
                // No headers exist, create first one
                await this.createFirstHeader(segment);
                return;
            }
            
            // Get the latest header
            const latestHeader = this.metadata.headers[this.metadata.headers.length - 1];
            const segmentContent = this.getSegmentContent(segment);
            
            // Check if header is locked (>= 3 segments)
            if (latestHeader.segments.length >= 3 && !latestHeader.locked) {
                latestHeader.locked = true;
                console.log(`🔒 Locked header "${latestHeader.title}" after 3 segments`);
            }
            
            const headerSummary = latestHeader.summary || '';
            const decision = await this.analyzeSegmentTopicDecisionWithSplitting(segmentContent, headerSummary, latestHeader.title, segment);
            
            if (decision.action === 'FIT') {
                // Assign to existing header (but don't update summary/title if locked)
                latestHeader.segments.push(segment.id);
                
                if (!latestHeader.locked) {
                    // Only update summary if not locked
                    await this.updateHeaderSummary(latestHeader, segmentContent);
                    
                    // Check if this locks the header
                    if (latestHeader.segments.length >= 3) {
                        latestHeader.locked = true;
                        console.log(`🔒 Locked header "${latestHeader.title}" after reaching 3 segments`);
                    }
                }
                
                this.saveMetadata();
                console.log(`Assigned segment ${segment.id} to ${latestHeader.locked ? 'locked ' : ''}header: "${latestHeader.title}"`);
                
                if (this.electronApp) {
                    this.electronApp.sendTopicUpdate({
                        type: 'segment-assigned',
                        header: latestHeader,
                        segment: segment
                    });
                }
            } else if (decision.action === 'EVOLVE' && !latestHeader.locked) {
                // For unlocked headers with EVOLVE, decide between header evolution or sub-header creation
                const shouldCreateSubHeader = await this.shouldCreateSubHeaderForEvolution(segmentContent, latestHeader, decision.newTitle);
                
                if (shouldCreateSubHeader) {
                    console.log(`Creating sub-header instead of evolving unlocked header: "${latestHeader.title}"`);
                    await this.assignToSubHeaderOrCreate(latestHeader, segment, segmentContent);
                } else {
                    // Proceed with header evolution
                    const oldTitle = latestHeader.title;
                    latestHeader.title = decision.newTitle;
                    latestHeader.segments.push(segment.id);
                    await this.updateHeaderSummary(latestHeader, segmentContent);
                    
                    // Check if this locks the header
                    if (latestHeader.segments.length >= 3) {
                        latestHeader.locked = true;
                        console.log(`🔒 Locked header "${latestHeader.title}" after reaching 3 segments`);
                    }
                    
                    this.saveMetadata();
                    console.log(`Evolved header from "${oldTitle}" to "${latestHeader.title}"`);
                    
                    if (this.electronApp) {
                        this.electronApp.sendTopicUpdate({
                            type: 'header-evolved',
                            header: latestHeader,
                            segment: segment,
                            oldTitle: oldTitle
                        });
                    }
                }
            } else if (decision.action === 'EVOLVE' && latestHeader.locked) {
                // Header is locked but content wants to evolve - try sub-headers
                console.log(`Header "${latestHeader.title}" is locked, trying sub-headers for evolution`);
                await this.assignToSubHeaderOrCreate(latestHeader, segment, segmentContent);
            } else if (decision.action === 'SPLIT') {
                // Split the segment at the detected topic boundary
                console.log(`🔪 Topic change detected within segment ${segment.id} at word ${decision.splitWordIndex}`);
                await this.handleSegmentSplit(segment, decision, latestHeader);
            } else {
                // NEW topic decision - check if it should be a sub-header (for both locked and unlocked headers)
                const belongsToMainTopic = await this.analyzeMainTopicRelatedness(segmentContent, latestHeader.title);
                if (belongsToMainTopic) {
                    console.log(`Creating sub-header under ${latestHeader.locked ? 'locked' : 'unlocked'} header: "${latestHeader.title}"`);
                    await this.assignToSubHeaderOrCreate(latestHeader, segment, segmentContent);
                } else {
                    // Create new main header - content is not related to current topic
                    await this.createNewHeader(segment);
                }
            }
            
        } catch (error) {
            console.error('Error assigning segment to header:', error.message);
        }
    }

    async handleSegmentSplit(originalSegment, decision, currentHeader) {
        try {
            // Split the segment at the detected boundary
            const splitResult = this.splitSegmentAtWordIndex(originalSegment, decision.splitWordIndex);
            if (!splitResult) {
                console.error('Failed to split segment, falling back to original logic');
                // Fallback to treating as NEW
                await this.createNewHeader(originalSegment);
                return;
            }
            
            const { firstSegment, secondSegment } = splitResult;
            
            // First segment stays with current header (but don't update summary/title if locked)
            currentHeader.segments.push(firstSegment.id);
            
            if (!currentHeader.locked) {
                const firstSegmentContent = this.getContentByWordRange(firstSegment.startWordIndex, firstSegment.endWordIndex);
                await this.updateHeaderSummary(currentHeader, firstSegmentContent);
                
                // Check if this locks the header
                if (currentHeader.segments.length >= 3) {
                    currentHeader.locked = true;
                    console.log(`🔒 Locked header "${currentHeader.title}" after reaching 3 segments (post-split)`);
                }
            }
            
            // Handle second segment based on the decision
            let secondSegmentHeaderId = null;
            
            if (decision.secondPartAction === 'NEW') {
                // Create new header for second segment
                const newHeader = await this.createNewHeaderForSegment(secondSegment);
                secondSegmentHeaderId = newHeader.id;
            } else if (decision.secondPartAction === 'EVOLVE') {
                if (!currentHeader.locked) {
                    // Evolve current header and assign second segment to it
                    const oldTitle = currentHeader.title;
                    currentHeader.title = decision.newTitle;
                    currentHeader.segments.push(secondSegment.id);
                    
                    const secondSegmentContent = this.getContentByWordRange(secondSegment.startWordIndex, secondSegment.endWordIndex);
                    await this.updateHeaderSummary(currentHeader, secondSegmentContent);
                    
                    // Check if this locks the header
                    if (currentHeader.segments.length >= 3) {
                        currentHeader.locked = true;
                        console.log(`🔒 Locked header "${currentHeader.title}" after reaching 3 segments (post-split evolution)`);
                    }
                    
                    secondSegmentHeaderId = currentHeader.id;
                    
                    if (this.electronApp) {
                        this.electronApp.sendTopicUpdate({
                            type: 'header-evolved',
                            header: currentHeader,
                            segment: secondSegment,
                            oldTitle: oldTitle
                        });
                    }
                } else {
                    // Header is locked, try sub-headers for evolution
                    const secondSegmentContent = this.getContentByWordRange(secondSegment.startWordIndex, secondSegment.endWordIndex);
                    await this.assignToSubHeaderOrCreate(currentHeader, secondSegment, secondSegmentContent);
                    secondSegmentHeaderId = currentHeader.id;
                }
            }
            
            // Update metadata with the split segments
            this.updateMetadataAfterSplit(originalSegment, firstSegment, secondSegment, currentHeader.id, secondSegmentHeaderId);
            
            console.log(`✅ Successfully split segment ${originalSegment.id} at word ${decision.splitWordIndex}`);
            console.log(`   First part (${firstSegment.id}): assigned to "${currentHeader.title}"`);
            
            // Notify UI about the first segment assignment
            if (this.electronApp) {
                this.electronApp.sendTopicUpdate({
                    type: 'segment-assigned',
                    header: currentHeader,
                    segment: firstSegment
                });
            }
            
        } catch (error) {
            console.error('Error handling segment split:', error.message);
            // Fallback: treat original segment as NEW
            await this.createNewHeader(originalSegment);
        }
    }

    async createNewHeaderForSegment(segment) {
        try {
            console.log('Creating new header for split segment:', segment.id);
            
            // Create expanded context with overlap from previous content
            const expandedContext = this.createExpandedContextForNewTopic(segment);
            
            // Generate header using the expanded context
            const headerTitle = await this.generateHeader(expandedContext.startWordIndex, expandedContext.endWordIndex, 'segment');
            
            // Create initial summary for the header (use expanded context)
            const initialSummary = this.getContentByWordRange(expandedContext.startWordIndex, expandedContext.endWordIndex);
            
            // Create header metadata entry
            const headerId = `header-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const header = {
                id: headerId,
                title: headerTitle,
                segments: [segment.id],
                summary: initialSummary,
                locked: false,
                subHeaders: [],
                timestamp: new Date().toISOString()
            };
            
            this.metadata.headers.push(header);
            this.saveMetadata();
            
            console.log(`Created new header: "${headerTitle}" for split segment ${segment.id}`);
            
            // Notify electron app if available
            if (this.electronApp) {
                this.electronApp.sendTopicUpdate({
                    type: 'header-created',
                    header: header,
                    segment: segment
                });
            }
            
            return header;
            
        } catch (error) {
            console.error('Error creating new header for segment:', error.message);
            throw error;
        }
    }

    async shouldCreateSubHeaderForEvolution(segmentContent, currentHeader, proposedNewTitle) {
        try {
            // If header already has sub-headers, lean towards creating more sub-headers for consistency
            if (currentHeader.subHeaders && currentHeader.subHeaders.length > 0) {
                console.log('Header already has sub-headers, preferring sub-header creation for consistency');
                return true;
            }
            
            // If header has many segments already, prefer sub-headers to avoid over-broad main headers
            if (currentHeader.segments && currentHeader.segments.length >= 2) {
                console.log('Header already has multiple segments, preferring sub-header to maintain focus');
                return true;
            }
            
            // Use AI to decide between evolution and sub-header creation
            const prompt = `You are deciding whether to evolve a main header or create a sub-header for a SOFTWARE SOLUTION ARCHITECT meeting transcript.

CURRENT HEADER: "${currentHeader.title}"

EXISTING DISCUSSION SUMMARY:
${currentHeader.summary || 'No summary available'}

NEW CONTENT TO ORGANIZE:
${segmentContent}

PROPOSED EVOLVED HEADER: "${proposedNewTitle}"

Analyze whether this content should:
1. **EVOLVE** the main header (making it broader to include both existing and new content)
2. **SUBHEADER** create a sub-header (keeping the main header focused and creating a specific sub-topic)

Consider:
- Would the evolved header be too broad and lose focus?
- Is the new content a distinct sub-aspect of the main topic?
- Would a sub-header provide better organization and clarity?
- Is the proposed evolution natural and coherent?

Guidelines:
- Prefer EVOLVE if the content naturally expands the current scope
- Prefer SUBHEADER if the content is a specific implementation detail or sub-aspect
- Prefer SUBHEADER if the evolved title would be too generic or broad

Respond with only "EVOLVE" or "SUBHEADER" - no explanations.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 50,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const response = message.content[0].text.trim().toUpperCase();
            const shouldCreateSubHeader = response === 'SUBHEADER';
            
            console.log(`Evolution decision: ${response} - ${shouldCreateSubHeader ? 'Creating sub-header' : 'Evolving main header'}`);
            return shouldCreateSubHeader;

        } catch (error) {
            console.error('Error determining evolution vs sub-header:', error.message);
            // Default to evolution for backward compatibility
            return false;
        }
    }

    async assignToSubHeaderOrCreate(mainHeader, segment, segmentContent) {
        try {
            // First, try to assign to existing sub-headers
            for (const subHeader of mainHeader.subHeaders) {
                const subHeaderSummary = subHeader.summary || '';
                const decision = await this.analyzeSubHeaderTopicDecision(segmentContent, subHeaderSummary, subHeader.title);
                
                if (decision.action === 'FIT') {
                    // Assign to existing sub-header
                    subHeader.segments.push(segment.id);
                    await this.updateSubHeaderSummary(subHeader, segmentContent);
                    this.saveMetadata();
                    
                    console.log(`Assigned segment ${segment.id} to sub-header: "${subHeader.title}"`);
                    
                    if (this.electronApp) {
                        this.electronApp.sendTopicUpdate({
                            type: 'subheader-assigned',
                            header: mainHeader,
                            subHeader: subHeader,
                            segment: segment
                        });
                    }
                    return;
                }
            }
            
            // No existing sub-header fits, check if it belongs to main topic
            const belongsToMainTopic = await this.analyzeMainTopicRelatedness(segmentContent, mainHeader.title);
            
            if (belongsToMainTopic) {
                // Create new sub-header under this main header
                await this.createSubHeader(mainHeader, segment, segmentContent);
            } else {
                // Doesn't belong to main topic, create new main header
                await this.createNewHeader(segment);
            }
            
        } catch (error) {
            console.error('Error in sub-header assignment:', error.message);
            // Fallback: create new main header
            await this.createNewHeader(segment);
        }
    }

    async createSubHeader(mainHeader, segment, segmentContent) {
        try {
            // Generate sub-header title
            const subHeaderTitle = await this.generateSubHeader(segment, mainHeader.title);
            
            // Create sub-header
            const subHeaderId = `subheader-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const subHeader = {
                id: subHeaderId,
                title: subHeaderTitle,
                segments: [segment.id],
                summary: segmentContent,
                parentId: mainHeader.id,
                timestamp: new Date().toISOString()
            };
            
            mainHeader.subHeaders.push(subHeader);
            this.saveMetadata();
            
            console.log(`📋 Created sub-header: "${subHeaderTitle}" under "${mainHeader.title}"`);
            
            if (this.electronApp) {
                this.electronApp.sendTopicUpdate({
                    type: 'subheader-created',
                    header: mainHeader,
                    subHeader: subHeader,
                    segment: segment
                });
            }
            
        } catch (error) {
            console.error('Error creating sub-header:', error.message);
        }
    }

    async createNewHeader(segment) {
        try {
            console.log('Creating new header for segment:', segment.id);
            
            // Create expanded context with overlap from previous content
            const expandedContext = this.createExpandedContextForNewTopic(segment);
            
            // Generate header using the expanded context
            const headerTitle = await this.generateHeader(expandedContext.startWordIndex, expandedContext.endWordIndex, 'segment');
            
            // Create initial summary for the header (use expanded context)
            const initialSummary = this.getContentByWordRange(expandedContext.startWordIndex, expandedContext.endWordIndex);
            
            // Create header metadata entry
            const headerId = `header-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const header = {
                id: headerId,
                title: headerTitle,
                segments: [segment.id],
                summary: initialSummary,
                locked: false,
                subHeaders: [],
                timestamp: new Date().toISOString()
            };
            
            this.metadata.headers.push(header);
            this.saveMetadata();
            
            console.log(`Created new header: "${headerTitle}" for segment ${segment.id}`);
            
            // Notify electron app if available
            if (this.electronApp) {
                this.electronApp.sendTopicUpdate({
                    type: 'header-created',
                    header: header,
                    segment: segment
                });
            }
            
        } catch (error) {
            console.error('Error creating new header:', error.message);
        }
    }

    async analyzeSubHeaderTopicDecision(segmentContent, subHeaderSummary, subHeaderTitle) {
        try {
            if (!segmentContent.trim() || !subHeaderSummary.trim()) {
                return { action: 'NEW' };
            }
            
            const prompt = `You are analyzing if a new segment fits under an existing SUB-HEADER in a meeting transcript for a SOFTWARE SOLUTION ARCHITECT.

SUB-HEADER: "${subHeaderTitle}"

EXISTING SUB-HEADER CONTENT:
${subHeaderSummary}

NEW SEGMENT TO EVALUATE:
${segmentContent}

Sub-headers can be MORE FLEXIBLE than main headers. Determine if the new segment fits:

Respond with "FIT" if:
- The segment is related to the same sub-topic
- It's a natural continuation or related detail
- It shares similar context or terminology
- It would logically belong under this sub-header

Respond with "NEW" if:
- It represents a genuinely different sub-topic
- It would be confusing to group with existing content

Be more lenient than main header decisions - sub-headers should capture related discussions.

Respond with only "FIT" or "NEW".`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 50,
                messages: [{ role: 'user', content: prompt }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const response = message.content[0].text.trim().toUpperCase();
            const fits = response === 'FIT';
            
            console.log(`Sub-header decision: ${fits ? 'FIT' : 'NEW'} - "${subHeaderTitle}"`);
            return { action: fits ? 'FIT' : 'NEW' };

        } catch (error) {
            console.error('Error analyzing sub-header fit:', error.message);
            return { action: 'NEW' };
        }
    }

    async analyzeMainTopicRelatedness(segmentContent, mainHeaderTitle) {
        try {
            const prompt = `Determine if this segment is related to the main topic for a SOFTWARE SOLUTION ARCHITECT meeting.

MAIN TOPIC: "${mainHeaderTitle}"

NEW SEGMENT:
${segmentContent}

Is this segment broadly related to the main topic? It doesn't need to fit perfectly - just be part of the same general discussion area.

Examples:
- Main topic "Database Design" could include performance, migration, security, etc.
- Main topic "API Implementation" could include authentication, testing, documentation, etc.

Respond with only "YES" if related to the main topic, or "NO" if it's a completely different area.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 50,
                messages: [{ role: 'user', content: prompt }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const response = message.content[0].text.trim().toUpperCase();
            const related = response === 'YES';
            
            console.log(`Main topic relatedness: ${related ? 'RELATED' : 'UNRELATED'} - "${mainHeaderTitle}"`);
            return related;

        } catch (error) {
            console.error('Error analyzing main topic relatedness:', error.message);
            return false;
        }
    }

    async generateSubHeader(segment, mainHeaderTitle) {
        try {
            const segmentContent = this.getSegmentContent(segment);
            
            const prompt = `Generate a concise sub-header (3-6 words) for this meeting content under the main topic.

MAIN TOPIC: "${mainHeaderTitle}"

CONTENT FOR SUB-HEADER:
${segmentContent}

The sub-header should:
- Be specific to this content
- Complement the main header
- Be clear and descriptive
- Use professional terminology

Examples:
- Main: "Database Design" → Sub: "Schema Migration"
- Main: "API Security" → Sub: "Authentication Setup"
- Main: "Performance Testing" → Sub: "Load Balancing"

CRITICAL: Respond with ONLY the sub-header title, no explanations.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 50,
                messages: [{ role: 'user', content: prompt }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const rawTitle = message.content[0].text.trim();
            const cleanTitle = this.cleanupHeaderText(rawTitle);
            
            console.log(`Generated sub-header: "${cleanTitle}"`);
            return cleanTitle;

        } catch (error) {
            console.error('Error generating sub-header:', error.message);
            return 'Sub-topic';
        }
    }

    async updateSubHeaderSummary(subHeader, newSegmentContent) {
        try {
            const currentSummary = subHeader.summary || '';
            const maxSummaryLength = 300; // Shorter for sub-headers
            
            if (currentSummary.length > maxSummaryLength) {
                subHeader.summary = await this.compressSummary(currentSummary, newSegmentContent);
            } else {
                const combinedContent = currentSummary + ' ' + newSegmentContent;
                
                if (combinedContent.length > maxSummaryLength) {
                    subHeader.summary = await this.compressSummary(currentSummary, newSegmentContent);
                } else {
                    subHeader.summary = combinedContent.trim();
                }
            }
            
            console.log(`Updated sub-header summary for "${subHeader.title}" (${subHeader.summary.length} chars)`);
            
        } catch (error) {
            console.error('Error updating sub-header summary:', error.message);
            subHeader.summary = (subHeader.summary || '') + ' ' + newSegmentContent;
        }
    }

    createExpandedContextForNewTopic(segment) {
        try {
            const OVERLAP_WORDS = 20;
            
            // Calculate the overlap start index (20 words before the current segment)
            const overlapStartIndex = Math.max(0, segment.startWordIndex - OVERLAP_WORDS);
            
            // Use the original segment end as the end of the expanded context
            const expandedEndIndex = segment.endWordIndex;
            
            console.log(`Creating expanded context: overlap from ${overlapStartIndex} to ${segment.startWordIndex - 1}, new segment ${segment.startWordIndex}-${segment.endWordIndex}`);
            
            return {
                startWordIndex: overlapStartIndex,
                endWordIndex: expandedEndIndex
            };
            
        } catch (error) {
            console.error('Error creating expanded context:', error.message);
            // Fallback to just the segment itself
            return {
                startWordIndex: segment.startWordIndex,
                endWordIndex: segment.endWordIndex
            };
        }
    }

    getSegmentContent(segment) {
        return this.getContentByWordRange(segment.startWordIndex, segment.endWordIndex);
    }

    getContentByWordRange(startWordIndex, endWordIndex) {
        try {
            const fullTranscript = this.getActiveTranscript();
            const words = fullTranscript.split(/\s+/).filter(word => word.length > 0);
            
            const startIndex = Math.max(0, startWordIndex);
            const endIndex = Math.min(words.length - 1, endWordIndex);
            
            return words.slice(startIndex, endIndex + 1).join(' ');
        } catch (error) {
            console.error('Error getting content by word range:', error.message);
            return '';
        }
    }

    getHeaderSegmentsContent(header) {
        try {
            const fullTranscript = this.getActiveTranscript();
            const words = fullTranscript.split(/\s+/).filter(word => word.length > 0);
            
            let combinedContent = '';
            
            for (const segmentId of header.segments) {
                const segment = this.metadata.segments.find(s => s.id === segmentId);
                if (segment) {
                    const startIndex = Math.max(0, segment.startWordIndex);
                    const endIndex = Math.min(words.length - 1, segment.endWordIndex);
                    const segmentContent = words.slice(startIndex, endIndex + 1).join(' ');
                    combinedContent += segmentContent + ' ';
                }
            }
            
            return combinedContent.trim();
        } catch (error) {
            console.error('Error getting header segments content:', error.message);
            return '';
        }
    }

    async analyzeSegmentTopicDecision(segmentContent, headerSummary, headerTitle) {
        try {
            if (!segmentContent.trim()) {
                return { action: 'NEW' };
            }
            
            // Handle case where header has no summary (backward compatibility)
            if (!headerSummary.trim()) {
                return { action: 'FIT' }; // Default to fit for headers without summaries
            }
            
            const prompt = `You are analyzing meeting transcript segments to determine topic organization for a SOFTWARE SOLUTION ARCHITECT.

CURRENT HEADER: "${headerTitle}"

SUMMARY OF EXISTING DISCUSSION:
${headerSummary}

NEW SEGMENT TO EVALUATE:
${segmentContent}

Determine the best action for organizing this new segment. You have THREE options:

1. **FIT** - The new segment fits perfectly under the current header without any changes
2. **EVOLVE** - The new segment is related but the header should be expanded/updated to better capture both existing and new content
3. **NEW** - The new segment represents a genuinely different topic that needs its own header

Guidelines:
- Use FIT when the new segment is clearly within the same specific topic area
- Use EVOLVE when the new segment adds a related dimension that makes the current header too narrow (e.g., "Database Migration" → "Database Migration and Performance")
- Use NEW only for completely different topics or major context shifts

Response format (IMPORTANT - follow exactly):
- If FIT: respond with just "FIT"
- If EVOLVE: respond with "EVOLVE: [new header title]" where the title is 3-8 words maximum
- If NEW: respond with just "NEW"

Examples of good EVOLVE responses:
- "EVOLVE: Database Migration and Performance"
- "EVOLVE: API Security Implementation"
- "EVOLVE: Configuration Management Setup"

DO NOT include explanations, reasoning, or additional text. Respond with ONLY the action and title.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const response = message.content[0].text.trim();
            
            if (response === 'FIT') {
                console.log(`Topic decision: FIT - "${headerTitle}"`);
                return { action: 'FIT' };
            } else if (response.startsWith('EVOLVE:')) {
                const rawNewTitle = response.substring(7).trim();
                const newTitle = this.cleanupHeaderText(rawNewTitle);
                console.log(`Topic decision: EVOLVE - "${headerTitle}" → "${newTitle}"`);
                return { action: 'EVOLVE', newTitle: newTitle };
            } else {
                console.log(`Topic decision: NEW - creating new header from "${headerTitle}"`);
                return { action: 'NEW' };
            }

        } catch (error) {
            console.error('Error analyzing segment topic decision:', error.message);
            // Default to creating new header on error
            return { action: 'NEW' };
        }
    }

    async analyzeSegmentTopicDecisionWithSplitting(segmentContent, headerSummary, headerTitle, segment) {
        try {
            if (!segmentContent.trim()) {
                return { action: 'NEW' };
            }
            
            // Handle case where header has no summary (backward compatibility)
            if (!headerSummary.trim()) {
                return { action: 'FIT' }; // Default to fit for headers without summaries
            }
            
            // First, get word-by-word content for analysis
            const segmentWords = segmentContent.split(/\s+/).filter(word => word.length > 0);
            
            // If segment is too short to meaningfully split, use original analysis
            if (segmentWords.length < 10) {
                return await this.analyzeSegmentTopicDecision(segmentContent, headerSummary, headerTitle);
            }
            
            const prompt = `You are analyzing a meeting transcript segment to determine if and where a topic change occurs for a SOFTWARE SOLUTION ARCHITECT.

CURRENT HEADER: "${headerTitle}"

SUMMARY OF EXISTING DISCUSSION:
${headerSummary}

NEW SEGMENT TO EVALUATE (with word positions):
${segmentWords.map((word, index) => `[${segment.startWordIndex + index}] ${word}`).join(' ')}

Analyze this segment and determine:

1. **TOPIC COHERENCE**: Does the entire segment fit the current header topic?

2. **TOPIC BOUNDARY DETECTION**: If there's a topic change within the segment, identify the exact word position where it occurs.

Response format (IMPORTANT - follow exactly):

- If the ENTIRE segment fits the current topic: "FIT"
- If the ENTIRE segment represents a new topic: "NEW" 
- If the ENTIRE segment expands the current topic: "EVOLVE: [new header title]"
- If there's a topic change WITHIN the segment: "SPLIT:[word_index]:[action_for_second_part]"

For SPLIT responses:
- word_index = the exact word position where the new topic begins
- action_for_second_part = either "NEW" or "EVOLVE: [title]"

Examples:
- "FIT" (entire segment fits current topic)
- "NEW" (entire segment is different topic)
- "EVOLVE: Database Migration and Performance" (entire segment expands topic)
- "SPLIT:${segment.startWordIndex + 15}:NEW" (topic changes at word 15, second part needs new header)
- "SPLIT:${segment.startWordIndex + 8}:EVOLVE: API Security Implementation" (topic changes at word 8, second part evolves header)

CRITICAL: Only suggest SPLIT if there's a clear topic boundary within the segment. Be conservative with splitting.

Respond with ONLY the action format - no explanations.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 150,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);
            this.displayCostReport(requestCost, inputTokens, outputTokens);

            const response = message.content[0].text.trim();
            console.log(`Topic decision with splitting analysis: ${response}`);
            
            if (response === 'FIT') {
                return { action: 'FIT' };
            } else if (response === 'NEW') {
                return { action: 'NEW' };
            } else if (response.startsWith('EVOLVE:')) {
                const rawNewTitle = response.substring(7).trim();
                const newTitle = this.cleanupHeaderText(rawNewTitle);
                return { action: 'EVOLVE', newTitle: newTitle };
            } else if (response.startsWith('SPLIT:')) {
                // Parse split response: SPLIT:[word_index]:[action]
                const parts = response.split(':');
                if (parts.length >= 3) {
                    const splitWordIndex = parseInt(parts[1]);
                    const secondPartAction = parts.slice(2).join(':'); // Rejoin in case of EVOLVE: title
                    
                    // Validate split word index
                    if (splitWordIndex > segment.startWordIndex && splitWordIndex <= segment.endWordIndex) {
                        if (secondPartAction === 'NEW') {
                            return { 
                                action: 'SPLIT', 
                                splitWordIndex: splitWordIndex,
                                secondPartAction: 'NEW'
                            };
                        } else if (secondPartAction.startsWith('EVOLVE:')) {
                            const rawNewTitle = secondPartAction.substring(7).trim();
                            const newTitle = this.cleanupHeaderText(rawNewTitle);
                            return { 
                                action: 'SPLIT', 
                                splitWordIndex: splitWordIndex,
                                secondPartAction: 'EVOLVE',
                                newTitle: newTitle
                            };
                        }
                    }
                }
                
                // If split parsing failed, fall back to NEW
                console.log(`Failed to parse split response: ${response}, falling back to NEW`);
                return { action: 'NEW' };
            } else {
                // Unrecognized response, fall back to NEW
                console.log(`Unrecognized response: ${response}, falling back to NEW`);
                return { action: 'NEW' };
            }

        } catch (error) {
            console.error('Error analyzing segment topic decision with splitting:', error.message);
            // Default to creating new header on error
            return { action: 'NEW' };
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
            
            // Notify electron app if available (for button state reset)
            if (this.electronApp) {
                this.electronApp.sendSummaryUpdate(this.currentSummary);
            }

        } catch (error) {
            console.error('Error creating summary from current transcript:', error.message);
            
            // Notify electron app of error completion if available
            if (this.electronApp) {
                this.electronApp.sendSummaryUpdate(null);
            }
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
        await this.initializeWordCount();
        
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