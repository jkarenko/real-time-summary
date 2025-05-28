#!/usr/bin/env node

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
        this.controlTrigger = 'Message to summary robot';
        this.controlSpeaker = 'Juho';
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
    }

    getSummaryFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_summary.txt`);
    }

    getNotesFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_notes.txt`);
    }

    getCompactedFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_compacted.txt`);
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
            // Create blank notes file
            fs.writeFileSync(this.notesFilePath, '', 'utf8');
            console.log(`📝 Created blank notes file: ${this.notesFilePath}`);
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

    displayScreenshotMenu(searchTerm = null, sessionOnly = false) {
        const allScreenshots = this.getScreenshotFiles();
        const baseScreenshots = sessionOnly ? this.getScreenshotFiles(true) : allScreenshots;
        
        if (allScreenshots.length === 0) {
            console.log('📸 No screenshots available');
            return;
        }

        if (sessionOnly && baseScreenshots.length === 0) {
            const sessionDuration = Math.round((Date.now() - this.startTime) / (1000 * 60));
            console.log(`📸 No screenshots taken during this session (${sessionDuration} minutes)`);
            console.log(`📊 Total screenshots available: ${allScreenshots.length}`);
            return;
        }

        // Filter screenshots if search term provided
        let screenshots = baseScreenshots;
        if (searchTerm) {
            screenshots = baseScreenshots.filter(screenshot => 
                path.basename(screenshot).toLowerCase().includes(searchTerm.toLowerCase())
            );
            
            if (screenshots.length === 0) {
                console.log(`📸 No screenshots found matching "${searchTerm}"`);
                if (sessionOnly) {
                    console.log(`📊 Session screenshots available: ${baseScreenshots.length}`);
                }
                console.log(`📊 Total screenshots available: ${allScreenshots.length}`);
                return;
            }
        }

        const totalPages = Math.ceil(screenshots.length / this.screenshotPageSize);
        const startIdx = this.currentScreenshotPage * this.screenshotPageSize;
        const endIdx = Math.min(startIdx + this.screenshotPageSize, screenshots.length);
        const pageScreenshots = screenshots.slice(startIdx, endIdx);

        console.log('\n📸 Available Screenshots:');
        if (sessionOnly) {
            const sessionDuration = Math.round((Date.now() - this.startTime) / (1000 * 60));
            console.log(`⏰ Session only (${sessionDuration} minutes) - ${baseScreenshots.length} screenshots`);
        }
        if (searchTerm) {
            console.log(`🔍 Filtered by: "${searchTerm}" (${screenshots.length} matches)`);
        }
        console.log(`📄 Page ${this.currentScreenshotPage + 1}/${totalPages} (${startIdx + 1}-${endIdx} of ${screenshots.length})`);
        console.log('═'.repeat(80));
        
        pageScreenshots.forEach((screenshot, pageIndex) => {
            const globalIndex = startIdx + pageIndex;
            const filename = path.basename(screenshot);
            const isSelected = this.selectedScreenshots.includes(screenshot);
            const status = isSelected ? '✅' : '⬜';
            console.log(`${globalIndex + 1}. ${status} ${filename}`);
        });
        
        console.log('═'.repeat(80));
        console.log(`📊 Currently selected: ${this.selectedScreenshots.length}/${allScreenshots.length} screenshots`);
        console.log('\nNavigation:');
        if (totalPages > 1) {
            console.log('  NEXT             - Next page');
            console.log('  PREV             - Previous page');
            console.log('  PAGE 3           - Jump to specific page');
        }
        console.log('  SEARCH term      - Filter screenshots by filename');
        console.log('  CLEAR SEARCH     - Show all screenshots');
        console.log('  SESSION          - Show only screenshots from current session');
        console.log('\nSelection:');
        console.log('  SELECT 1,3,5     - Select screenshots by numbers (comma-separated)');
        console.log('  SELECT ALL       - Select all screenshots (on current page/search)');
        console.log('  SELECT NONE      - Clear all selections');
        console.log('  SCREENSHOTS      - Refresh this menu');
    }

    handleScreenshotSelection(selectionInput, currentScreenshots = null) {
        const allScreenshots = this.getScreenshotFiles();
        const screenshots = currentScreenshots || allScreenshots;
        
        if (screenshots.length === 0) {
            console.log('📸 No screenshots available');
            return;
        }

        const upperInput = selectionInput.toUpperCase().trim();
        
        if (upperInput === 'ALL') {
            // Add all current page/search results to selection (don't replace existing)
            const newSelections = screenshots.filter(s => !this.selectedScreenshots.includes(s));
            this.selectedScreenshots.push(...newSelections);
            console.log(`✅ Added ${newSelections.length} screenshot(s) to selection`);
            console.log(`📊 Total selected: ${this.selectedScreenshots.length} screenshots`);
        } else if (upperInput === 'NONE') {
            this.selectedScreenshots = [];
            console.log('❌ Cleared all screenshot selections');
        } else {
            // Parse comma-separated numbers
            try {
                const numbers = upperInput.split(',').map(n => parseInt(n.trim()));
                const validNumbers = numbers.filter(n => n >= 1 && n <= allScreenshots.length);
                
                if (validNumbers.length === 0) {
                    console.log('⚠️  No valid screenshot numbers provided');
                    return;
                }
                
                const newSelections = validNumbers.map(n => allScreenshots[n - 1]);
                
                // Add to existing selections (toggle behavior)
                newSelections.forEach(screenshot => {
                    const index = this.selectedScreenshots.indexOf(screenshot);
                    if (index === -1) {
                        this.selectedScreenshots.push(screenshot);
                        console.log(`✅ Added: ${path.basename(screenshot)}`);
                    } else {
                        this.selectedScreenshots.splice(index, 1);
                        console.log(`❌ Removed: ${path.basename(screenshot)}`);
                    }
                });
                
                console.log(`📊 Total selected: ${this.selectedScreenshots.length} screenshots`);
                
            } catch (error) {
                console.log('⚠️  Invalid selection format. Use: SELECT 1,3,5 or SELECT ALL or SELECT NONE');
            }
        }
    }

    handleScreenshotNavigation(command) {
        const screenshots = this.getScreenshotFiles();
        if (screenshots.length === 0) return;

        const totalPages = Math.ceil(screenshots.length / this.screenshotPageSize);
        const upperCommand = command.toUpperCase().trim();

        if (upperCommand === 'NEXT') {
            if (this.currentScreenshotPage < totalPages - 1) {
                this.currentScreenshotPage++;
                this.displayScreenshotMenu();
            } else {
                console.log('📄 Already on last page');
            }
        } else if (upperCommand === 'PREV') {
            if (this.currentScreenshotPage > 0) {
                this.currentScreenshotPage--;
                this.displayScreenshotMenu();
            } else {
                console.log('📄 Already on first page');
            }
        } else if (upperCommand.startsWith('PAGE ')) {
            try {
                const pageNum = parseInt(upperCommand.substring(5).trim());
                if (pageNum >= 1 && pageNum <= totalPages) {
                    this.currentScreenshotPage = pageNum - 1;
                    this.displayScreenshotMenu();
                } else {
                    console.log(`⚠️  Page must be between 1 and ${totalPages}`);
                }
            } catch (error) {
                console.log('⚠️  Invalid page number format. Use: PAGE 3');
            }
        }
    }

    saveNote(note) {
        const now = new Date();
        const timestamp = now.getFullYear() + '-' + 
                         String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                         String(now.getDate()).padStart(2, '0') + ' ' + 
                         String(now.getHours()).padStart(2, '0') + ':' + 
                         String(now.getMinutes()).padStart(2, '0') + ':' + 
                         String(now.getSeconds()).padStart(2, '0');
        const noteEntry = `[${timestamp}] ${note}\n\n`;
        fs.appendFileSync(this.notesFilePath, noteEntry, 'utf8');
    }

    displayExistingTranscript() {
        try {
            const existingContent = fs.readFileSync(this.filePath, 'utf8');
            
            if (existingContent.trim()) {
                console.log('\n📖 Existing transcript content:');
                console.log('═'.repeat(60));
                console.log(existingContent.trim());
                console.log('═'.repeat(60));
                console.log(`📊 Total content: ${existingContent.length} characters`);
                
                // Count words in existing content for pending calculation
                const lines = existingContent.split('\n');
                const regularContent = [];
                
                for (const line of lines) {
                    const parsed = this.parseTranscriptLine(line);
                    if (parsed && 
                        parsed.speaker === this.controlSpeaker && 
                        parsed.content.includes(this.controlTrigger)) {
                        // Skip control instructions
                        continue;
                    } else {
                        regularContent.push(line);
                    }
                }
                
                const cleanContent = regularContent.join('\n').trim();
                if (cleanContent) {
                    const wordCount = cleanContent.split(/\s+/).length;
                    console.log(`👁️  ${wordCount} words available for summarization`);
                    
                    // Pre-load into pending content for SUMMARIZE command
                    this.pendingContent = cleanContent;
                }
            } else {
                console.log('\n📖 Transcript file is empty - waiting for content...');
            }
        } catch (error) {
            console.log('\n⚠️  Could not read existing transcript content:', error.message);
        }
    }

    saveSummary() {
        fs.writeFileSync(this.summaryFilePath, this.currentSummary, 'utf8');
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
        
        // Update and display context usage
        this.updateContextUsage();
        const contextPercentage = Math.round((this.contextUsage / this.maxContextTokens) * 100);
        console.log(`📊 Context usage: ${this.contextUsage.toLocaleString()} tokens (${contextPercentage}%)`);
        
        if (contextPercentage > 70) {
            console.log('⚠️  Context getting large - consider using COMPACT command');
        }
        
        console.log('─'.repeat(50));
    }

    estimateTokenCount(text) {
        // Rough estimation: ~1.3 tokens per word for English text
        const words = text.trim().split(/\s+/).length;
        return Math.ceil(words * 1.3);
    }

    updateContextUsage() {
        try {
            const transcriptToUse = this.useCompressed && this.compressedTranscript 
                ? this.compressedTranscript 
                : fs.readFileSync(this.filePath, 'utf8');
            this.contextUsage = this.estimateTokenCount(transcriptToUse) + 
                               this.estimateTokenCount(this.currentSummary);
        } catch (error) {
            // If we can't read the file, estimate from pending content
            this.contextUsage = this.estimateTokenCount(this.pendingContent) + 
                               this.estimateTokenCount(this.currentSummary);
        }
    }

    getActiveTranscript() {
        // Get the transcript to use for AI operations (compressed if available and active)
        if (this.useCompressed && this.compressedTranscript) {
            const newContent = fs.readFileSync(this.filePath, 'utf8');
            // Append any new content since compression to the compressed version
            return this.compressedTranscript + '\n' + this.pendingContent;
        } else {
            return fs.readFileSync(this.filePath, 'utf8');
        }
    }

    async compactTranscript() {
        try {
            const fullTranscript = fs.readFileSync(this.filePath, 'utf8');
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content to compact');
                return;
            }

            console.log(`🗜️  Compacting transcript (${this.estimateTokenCount(fullTranscript)} tokens)`);
            
            const prompt = `You are compacting a meeting transcript for efficient LLM processing. Your goal is to preserve ALL crucial information while reducing token count by 60-70%.

ORIGINAL TRANSCRIPT:
${fullTranscript}

PRESERVE EXACTLY:
- All participant names, roles, and speaker attributions for key points
- All technical terms, system names, tools, processes (Jira X-Ray, M4DevOps, etc.)
- All specific decisions, action items, timelines, and concrete outcomes
- All questions/answers and important clarifications
- All numerical data, percentages, dates, and metrics
- Context about WHO said WHAT for important statements

SELECTIVE COMPRESSION:
- Remove articles (a, an, the) where meaning remains clear
- Use contractions and shorter verb forms
- Convert wordy phrases to concise equivalents
- Remove conversational filler and redundant explanations
- Combine similar points from same speaker
- Use telegraphic style for process descriptions

KEEP STRUCTURE:
- Logical flow and chronological order
- Speaker context: "Emma: [key point]" or "Otto mentioned [technical detail]"
- Clear section divisions
- Technical accuracy and business context

Example transformations:
"Emma explained that the testing process involves..." → "Emma: Testing process involves..."
"There was a discussion about whether..." → "Discussion: whether..."
"It was mentioned by Otto that the system..." → "Otto: System..."

Compress this transcript while preserving who said what:

Compacted transcript:`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 8000,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const compactedTranscript = message.content[0].text;
            
            // Store compressed version in memory AND save to file
            this.compressedTranscript = compactedTranscript;
            this.useCompressed = true;
            
            // Save compacted version to file for reference
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const compactedContent = `# Compacted Transcript\n# Generated: ${timestamp}\n# Original size: ${fullTranscript.length} chars -> Compacted: ${compactedTranscript.length} chars\n\n${compactedTranscript}`;
            fs.writeFileSync(this.compactedFilePath, compactedContent, 'utf8');
            
            const oldTokens = this.estimateTokenCount(fullTranscript);
            const newTokens = this.estimateTokenCount(compactedTranscript);
            
            console.log(`\n🗜️  TRANSCRIPT COMPRESSED`);
            console.log(`📊 Before: ${oldTokens.toLocaleString()} tokens (${fullTranscript.length} chars)`);
            console.log(`📊 After: ${newTokens.toLocaleString()} tokens (${compactedTranscript.length} chars)`);
            console.log(`📁 Original file unchanged - using compressed version for AI operations`);
            console.log(`💾 Compacted version saved to: ${this.compactedFilePath}`);
            console.log(`🔄 Type 'UNCOMPACT' to revert to using original transcript`);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

        } catch (error) {
            console.error('Error compacting transcript:', error.message);
        }
    }

    async condenseSummaryIfNeeded() {
        const estimatedTokens = this.estimateTokenCount(this.currentSummary);
        
        if (estimatedTokens > this.maxSummaryTokens) {
            console.log(`\n🗜️  Summary too long (${estimatedTokens} tokens), condensing...`);
            
            const condensePrompt = `You are condensing a meeting summary that has grown too long. Your task is to reduce it to essential information while maintaining all critical technical details.

CURRENT SUMMARY (TOO LONG):
${this.currentSummary}

CONDENSATION INSTRUCTIONS:
- KEEP all specific technical details, system names, file paths, and architectural decisions
- KEEP the "Questions for Further Investigation" section (it's valuable for the architect)
- REMOVE redundant explanations and verbose descriptions
- MERGE related bullet points where possible
- PRIORITIZE technical facts over meeting logistics
- MAINTAIN section structure but make each point more concise
- TARGET: Reduce to approximately 3000-3500 tokens while preserving technical value

CRITICAL: Do not lose important technical information - just make it more concise.

Condensed summary:`;

            try {
                const message = await this.anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: condensePrompt
                    }]
                });

                const inputTokens = message.usage.input_tokens;
                const outputTokens = message.usage.output_tokens;
                const requestCost = this.calculateCost(inputTokens, outputTokens);

                const oldLength = this.currentSummary.length;
                this.currentSummary = message.content[0].text;
                this.saveSummary();
                
                const newEstimatedTokens = this.estimateTokenCount(this.currentSummary);
                
                console.log(`\n🗜️  SUMMARY CONDENSED`);
                console.log(`📊 Before: ${estimatedTokens} tokens (${oldLength} chars)`);
                console.log(`📊 After: ${newEstimatedTokens} tokens (${this.currentSummary.length} chars)`);
                console.log(`💾 Condensed summary saved to: ${this.summaryFilePath}`);
                
                this.displayCostReport(requestCost, inputTokens, outputTokens);

            } catch (error) {
                console.error('Error condensing summary:', error.message);
            }
        }
    }

    parseTranscriptLine(line) {
        // Parse format: [00:42:55.55] Juho: Message content
        const timestampMatch = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{2})\]\s*([^:]+):\s*(.+)$/);
        if (timestampMatch) {
            return {
                timestamp: timestampMatch[1],
                speaker: timestampMatch[2].trim(),
                content: timestampMatch[3].trim()
            };
        }
        return null;
    }

    extractControlInstructions(newContent) {
        const lines = newContent.split('\n');
        const controlInstructions = [];
        const regularContent = [];

        for (const line of lines) {
            const parsed = this.parseTranscriptLine(line);
            if (parsed && 
                parsed.speaker === this.controlSpeaker && 
                parsed.content.includes(this.controlTrigger)) {
                
                // Extract instruction after trigger phrase
                const triggerIndex = parsed.content.indexOf(this.controlTrigger);
                const instruction = parsed.content.substring(triggerIndex + this.controlTrigger.length).trim();
                
                if (instruction) {
                    controlInstructions.push({
                        timestamp: parsed.timestamp,
                        instruction: instruction.replace(/^[.,!?]\s*/, '') // Remove leading punctuation
                    });
                    console.log(`🎛️  Control instruction detected: "${instruction}"`);
                } else {
                    console.log(`🎛️  Empty control instruction detected at ${parsed.timestamp}`);
                }
            } else {
                regularContent.push(line);
            }
        }

        return {
            controlInstructions,
            regularContent: regularContent.join('\n').trim()
        };
    }

    async processControlInstruction(instruction) {
        if (!this.currentSummary) {
            console.log('⚠️  No existing summary to modify with control instruction');
            console.log('🔍 Current summary length:', this.currentSummary?.length || 0);
            return;
        }
        
        console.log('🔍 DEBUG: Processing control instruction with existing summary length:', this.currentSummary.length);

        const prompt = `You are managing a real-time meeting summary. You have received a control instruction to modify the current summary.

CURRENT SUMMARY:
${this.currentSummary}

CONTROL INSTRUCTION:
${instruction}

INSTRUCTIONS:
- MUST apply the requested modification to the summary
- If asked to add a section, ADD IT - do not ignore the request
- If asked to change terminology, CHANGE IT throughout the document
- If asked to restructure, DO IT completely
- Return the COMPLETE modified summary with all requested changes implemented
- Do NOT return the summary unchanged - you MUST make the requested modifications

IMPORTANT: The user expects to see changes. If you don't make changes, they will think the system is broken.

Modified summary:`;

        try {
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
            
            console.log('\n🎛️  CONTROL INSTRUCTION APPLIED - SUMMARY UPDATED');
            console.log('═'.repeat(60));
            console.log('🔍 DEBUG: Updated summary length:', this.currentSummary.length);
            console.log('🔍 DEBUG: First 200 chars:', this.currentSummary.substring(0, 200));
            console.log(this.currentSummary);
            console.log('═'.repeat(60));
            console.log(`💾 Updated summary saved to: ${this.summaryFilePath}`);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);
            
            // Check if summary needs condensing after control instruction
            await this.condenseSummaryIfNeeded();

        } catch (error) {
            console.error('Error processing control instruction:', error.message);
        }
    }

    async regenerateFromFullTranscript() {
        try {
            // Read the entire transcript file
            const fullTranscript = fs.readFileSync(this.filePath, 'utf8');
            
            console.log(`📖 Read full transcript: ${fullTranscript.length} characters`);
            
            // Extract only regular content (no control instructions for regeneration)
            const lines = fullTranscript.split('\n');
            const regularContent = [];
            
            for (const line of lines) {
                const parsed = this.parseTranscriptLine(line);
                if (parsed && 
                    parsed.speaker === this.controlSpeaker && 
                    parsed.content.includes(this.controlTrigger)) {
                    // Skip control instructions during regeneration
                    continue;
                } else {
                    regularContent.push(line);
                }
            }
            
            const cleanTranscript = regularContent.join('\n').trim();
            
            if (!cleanTranscript) {
                console.log('⚠️  No transcript content found to regenerate from');
                return;
            }
            
            console.log(`🧹 Cleaned transcript: ${cleanTranscript.length} characters (removed control instructions)`);
            
            // Reset current summary and regenerate from scratch
            this.currentSummary = '';
            this.pendingContent = '';
            
            // Read existing notes for additional context
            let existingNotes = '';
            try {
                if (fs.existsSync(this.notesFilePath)) {
                    existingNotes = fs.readFileSync(this.notesFilePath, 'utf8').trim();
                }
            } catch (error) {
                console.log('⚠️  Could not read notes file for context');
            }

            // Use the initial summary prompt (not the update prompt)
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
            
            // Reset to end of file position
            this.lastPosition = fs.statSync(this.filePath).size;
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);
            
            // Check if regenerated summary needs condensing
            await this.condenseSummaryIfNeeded();
            
            console.log('\n🔄 SUMMARY REGENERATED FROM FULL TRANSCRIPT');
            console.log('═'.repeat(60));
            console.log(this.currentSummary);
            console.log('═'.repeat(60));
            console.log(`💾 Fresh summary saved to: ${this.summaryFilePath}`);
            console.log(`📍 Position reset to end of file: ${this.lastPosition}`);

        } catch (error) {
            console.error('Error regenerating summary from full transcript:', error.message);
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
            
            // Extract only regular content (no control instructions)
            const lines = fullTranscript.split('\n');
            const regularContent = [];
            
            for (const line of lines) {
                const parsed = this.parseTranscriptLine(line);
                if (parsed && 
                    parsed.speaker === this.controlSpeaker && 
                    parsed.content.includes(this.controlTrigger)) {
                    // Skip control instructions
                    continue;
                } else {
                    regularContent.push(line);
                }
            }
            
            const cleanTranscript = regularContent.join('\n').trim();
            
            if (!cleanTranscript) {
                console.log('⚠️  No meeting content found to summarize (only control instructions)');
                return;
            }
            
            console.log(`🧹 Clean transcript: ${cleanTranscript.length} characters`);
            
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
                
                // Check if summary needs condensing
                await this.condenseSummaryIfNeeded();
                
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

    async createNote(noteRequest, forceTextOnly = false) {
        try {
            // Get the active transcript (compressed if available)
            const fullTranscript = this.getActiveTranscript();
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content available for note context');
                return;
            }

            const messages = [];

            let promptText = `You are an AI assistant helping create concise meeting notes for a SOFTWARE SOLUTION ARCHITECT. You have access to the meeting transcript and are asked to create a brief note about a specific topic.

MEETING TRANSCRIPT:
${fullTranscript}

NOTE REQUEST:
${noteRequest}

INSTRUCTIONS:
- Create a brief, focused note (2-4 sentences) based on the request and transcript content
- Include only the most relevant details from the transcript related to the request
- Use a conversational, note-taking style rather than formal documentation
- If the topic isn't discussed in the transcript, state that clearly
- Keep it concise - this is a quick note, not a full analysis
- IMPORTANT: Write the note in the same language as the note request - if the request is in Finnish, respond in Finnish; if in English, respond in English`;

            const useScreenshots = !forceTextOnly && this.selectedScreenshots.length > 0;
            
            if (useScreenshots) {
                promptText += `\n- You also have access to ${this.selectedScreenshots.length} selected meeting screenshot(s) that may provide visual context`;
            }

            promptText += `\n\nBrief note:`;

            // Add text content
            const content = [{ type: 'text', text: promptText }];

            // Add selected screenshots (unless forced text-only)
            if (useScreenshots) {
                console.log(`📸 Including ${this.selectedScreenshots.length} selected screenshot(s) for context`);
                
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
                        console.log(`   📸 ${path.basename(screenshotPath)}`);
                    } catch (error) {
                        console.log(`⚠️  Could not read screenshot ${screenshotPath}:`, error.message);
                    }
                }
            } else if (forceTextOnly && this.selectedScreenshots.length > 0) {
                console.log(`📝 Skipping ${this.selectedScreenshots.length} screenshot(s) for faster processing`);
            }

            messages.push({ role: 'user', content });

            // Check if we should try without screenshots first to reduce load
            const hasScreenshots = this.selectedScreenshots.length > 0;
            let shouldRetryWithoutScreenshots = false;

            // Retry logic for API errors
            let message;
            let retryCount = 0;
            const maxRetries = 3;
            
            while (retryCount <= maxRetries) {
                try {
                    // If we've failed with screenshots, try without them
                    const messagesToSend = shouldRetryWithoutScreenshots && hasScreenshots 
                        ? [{ role: 'user', content: [{ type: 'text', text: promptText }] }]
                        : messages;
                    
                    if (shouldRetryWithoutScreenshots && hasScreenshots) {
                        console.log('🔄 Retrying without screenshots to reduce request size...');
                    }

                    message = await this.anthropic.messages.create({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 300,
                        messages: messagesToSend
                    });
                    break; // Success, exit retry loop
                } catch (error) {
                    retryCount++;
                    
                    if (error.status === 529) {
                        if (retryCount === 2 && hasScreenshots && !shouldRetryWithoutScreenshots) {
                            // After first retry with screenshots fails, try without them
                            shouldRetryWithoutScreenshots = true;
                            retryCount--; // Don't count this as a retry attempt
                        } else if (retryCount <= maxRetries) {
                            const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
                            console.log(`⏳ API overloaded, retrying in ${waitTime/1000} seconds... (attempt ${retryCount}/${maxRetries})`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        } else {
                            throw error;
                        }
                    } else {
                        throw error; // Re-throw if not retryable
                    }
                }
            }

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const noteContent = message.content[0].text;
            this.saveNote(`NOTE: ${noteRequest}\n\n${noteContent}`);
            
            console.log('📝 AI-ASSISTED NOTE CREATED:');
            console.log('─'.repeat(50));
            console.log(noteContent);
            console.log('─'.repeat(50));
            console.log(`💾 Note saved to: ${this.notesFilePath}`);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

        } catch (error) {
            console.error('Error creating note:', error.message);
        }
    }

    async answerQuestion(question) {
        try {
            // Get the active transcript (compressed if available)
            const fullTranscript = this.getActiveTranscript();
            
            if (!fullTranscript.trim()) {
                console.log('⚠️  No transcript content available to answer questions');
                return;
            }

            const messages = [];

            let promptText = `You are an AI assistant helping a SOFTWARE SOLUTION ARCHITECT understand a meeting transcript. Answer the user's question based on the meeting content.

MEETING TRANSCRIPT:
${fullTranscript}

QUESTION:
${question}

INSTRUCTIONS:
- Answer the question directly and concisely based on the transcript content
- If the information is not in the transcript, clearly state that
- Include relevant quotes or references from the transcript when helpful
- Focus on technical accuracy and architect-relevant details
- If the question is unclear, ask for clarification`;

            if (this.selectedScreenshots.length > 0) {
                promptText += `\n- You also have access to ${this.selectedScreenshots.length} selected meeting screenshot(s) that may provide visual context`;
            }

            promptText += `\n\nAnswer:`;

            // Add text content
            const content = [{ type: 'text', text: promptText }];

            // Add selected screenshots
            if (this.selectedScreenshots.length > 0) {
                console.log(`📸 Including ${this.selectedScreenshots.length} selected screenshot(s) for context`);
                
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
                        console.log(`   📸 ${path.basename(screenshotPath)}`);
                    } catch (error) {
                        console.log(`⚠️  Could not read screenshot ${screenshotPath}:`, error.message);
                    }
                }
            }

            messages.push({ role: 'user', content });

            // Retry logic for API errors
            let message;
            let retryCount = 0;
            const maxRetries = 3;
            
            while (retryCount <= maxRetries) {
                try {
                    message = await this.anthropic.messages.create({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 1500,
                        messages
                    });
                    break; // Success, exit retry loop
                } catch (error) {
                    retryCount++;
                    
                    if (error.status === 529 && retryCount <= maxRetries) {
                        const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
                        console.log(`⏳ API overloaded, retrying in ${waitTime/1000} seconds... (attempt ${retryCount}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        throw error; // Re-throw if not retryable or max retries exceeded
                    }
                }
            }

            const inputTokens = message.usage.input_tokens;
            const outputTokens = message.usage.output_tokens;
            const requestCost = this.calculateCost(inputTokens, outputTokens);

            const answer = message.content[0].text;
            
            console.log('💬 ANSWER:');
            console.log('─'.repeat(50));
            console.log(answer);
            console.log('─'.repeat(50));
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

        } catch (error) {
            console.error('Error answering question:', error.message);
        }
    }

    setupTextControlChannel() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: ''
        });

        this.rl.on('line', async (input) => {
            const rawInput = input.trim();
            const upperInput = rawInput.toUpperCase();
            
            if (rawInput) {
                if (upperInput === 'REGENERATE') {
                    console.log(`\n🔄 REGENERATING SUMMARY FROM ENTIRE TRANSCRIPT`);
                    console.log('⏳ Reading full transcript file and rebuilding summary...\n');
                    await this.regenerateFromFullTranscript();
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'SUMMARIZE') {
                    console.log(`\n📝 CREATING SUMMARY FROM CURRENT TRANSCRIPT`);
                    console.log('⏳ Processing accumulated content...\n');
                    await this.createSummaryFromCurrent();
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'COMPACT') {
                    console.log(`\n🗜️  COMPACTING TRANSCRIPT TO REDUCE CONTEXT SIZE`);
                    console.log('⏳ Analyzing and compressing transcript...\n');
                    await this.compactTranscript();
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'UNCOMPACT') {
                    this.useCompressed = false;
                    this.compressedTranscript = null;
                    console.log(`\n🔄 Reverted to using original uncompressed transcript`);
                    console.log('📁 All future AI operations will use the original file');
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'READONLY') {
                    this.readOnlyMode = !this.readOnlyMode;
                    console.log(`\n🔄 Read-only mode: ${this.readOnlyMode ? 'ON' : 'OFF'}`);
                    if (!this.readOnlyMode) {
                        console.log('📝 Will now auto-update summary when content threshold reached');
                    } else {
                        console.log('👁️  Will only monitor transcript - use SUMMARIZE to create summaries');
                    }
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'SCREENSHOTS') {
                    this.currentScreenshotPage = 0; // Reset to first page
                    this.displayScreenshotMenu();
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'NEXT' || upperInput === 'PREV' || upperInput.startsWith('PAGE ')) {
                    this.handleScreenshotNavigation(rawInput);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('SEARCH ')) {
                    const searchTerm = rawInput.substring(7).trim();
                    this.currentScreenshotPage = 0; // Reset to first page for search
                    this.displayScreenshotMenu(searchTerm);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'CLEAR SEARCH') {
                    this.currentScreenshotPage = 0;
                    this.displayScreenshotMenu();
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput === 'SESSION') {
                    this.currentScreenshotPage = 0;
                    this.displayScreenshotMenu(null, true);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('SELECT ')) {
                    const selectionInput = rawInput.substring(7); // Remove "SELECT "
                    this.handleScreenshotSelection(selectionInput);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('INSTRUCTION ')) {
                    const instruction = rawInput.substring(12); // Remove "INSTRUCTION "
                    console.log(`\n⌨️  PROCESSING SUMMARY INSTRUCTION: "${instruction}"`);
                    console.log('⏳ Applying instruction to summary...\n');
                    await this.processControlInstruction(instruction);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('NOTE! ')) {
                    const noteRequest = rawInput.substring(6); // Remove "NOTE! "
                    console.log(`\n📝 CREATING AI-ASSISTED NOTE (TEXT-ONLY): "${noteRequest}"`);
                    console.log('⏳ Generating note from transcript context...\n');
                    await this.createNote(noteRequest, true); // Force text-only
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('NOTE ')) {
                    const noteRequest = rawInput.substring(5); // Remove "NOTE "
                    console.log(`\n📝 CREATING AI-ASSISTED NOTE: "${noteRequest}"`);
                    console.log('⏳ Generating note from transcript context...\n');
                    await this.createNote(noteRequest);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else if (upperInput.startsWith('ASK ')) {
                    const question = rawInput.substring(4); // Remove "ASK "
                    console.log(`\n❓ ANSWERING QUESTION: "${question}"`);
                    console.log('⏳ Analyzing transcript for answer...\n');
                    await this.answerQuestion(question);
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                } else {
                    // Unknown command
                    console.log(`\n❌ Unknown command: "${rawInput}"`);
                    console.log('\n💬 Available commands:');
                    console.log('   SUMMARIZE - Create/update summary from current transcript');
                    console.log('   REGENERATE - Rebuild summary from entire transcript');
                    console.log('   COMPACT - Compress transcript to reduce context size');
                    console.log('   UNCOMPACT - Revert to using original uncompressed transcript');
                    console.log('   READONLY - Toggle read-only mode on/off');
                    console.log('   SCREENSHOTS - Show screenshot selection menu (paginated)');
                    console.log('   SESSION - Show only screenshots from current session');
                    console.log('   NEXT/PREV - Navigate screenshot pages');
                    console.log('   SEARCH term - Filter screenshots by filename');
                    console.log('   SELECT 1,3,5 - Select/toggle screenshots by numbers');
                    console.log('   INSTRUCTION [text] - Modify summary');
                    console.log('   NOTE [text] - Add AI-assisted note to notes file');
                    console.log('   NOTE! [text] - Create note without screenshots (faster)');
                    console.log('   ASK [question] - Ask question about transcript');
                    console.log('\n💬 Ready for next command (or continue with meeting)');
                }
            }
        });

        // Initially hide the prompt until first instruction is needed
        console.log('\n💬 Text Control Channel: Type commands and press Enter');
        console.log('   SUMMARIZE - Create/update summary from current transcript');
        console.log('   REGENERATE - Rebuild summary from entire transcript');
        console.log('   COMPACT - Compress transcript to reduce context size');
        console.log('   UNCOMPACT - Revert to using original uncompressed transcript');
        console.log('   READONLY - Toggle read-only mode on/off');
        console.log('   SCREENSHOTS - Show screenshot selection menu (paginated)');
        console.log('   SESSION - Show only screenshots from current session');
        console.log('   NEXT/PREV - Navigate screenshot pages');
        console.log('   SEARCH term - Filter screenshots by filename');
        console.log('   SELECT 1,3,5 - Select/toggle screenshots by numbers');
        console.log('   INSTRUCTION [text] - Modify summary (e.g., "INSTRUCTION Split payment section")');
        console.log('   NOTE [text] - Add AI-assisted note to notes file');
        console.log('   NOTE! [text] - Create note without screenshots (faster)');
        console.log('   ASK [question] - Ask question about transcript (CLI response only)');
    }

    async start() {
        console.log(`Monitoring transcript file: ${this.filePath}`);
        console.log(`Summary will be saved to: ${this.summaryFilePath}`);
        console.log(`Notes will be saved to: ${this.notesFilePath}`);
        console.log(`Compacted transcripts will be saved to: ${this.compactedFilePath}`);
        if (this.screenshotsDir) {
            console.log(`Screenshots directory: ${this.screenshotsDir}`);
        }
        console.log(`🎛️  Control channel: Say "${this.controlTrigger}" as "${this.controlSpeaker}" to send instructions`);
        console.log(`👁️  Started in READ-ONLY mode - use SUMMARIZE command to create summaries`);
        
        if (!fs.existsSync(this.filePath)) {
            console.error(`File does not exist: ${this.filePath}`);
            process.exit(1);
        }

        this.loadExistingSummary();
        this.loadOrCreateNotesFile();
        
        if (this.readOnlyMode) {
            // In read-only mode, display existing transcript content
            this.displayExistingTranscript();
        }
        
        this.lastPosition = fs.statSync(this.filePath).size;
        console.log(`Starting from position: ${this.lastPosition}`);

        // Setup text control channel
        this.setupTextControlChannel();

        fs.watchFile(this.filePath, { interval: 1000 }, async (curr, prev) => {
            if (curr.mtime > prev.mtime) {
                await this.processNewContent();
            }
        });

        console.log('\nPress Ctrl+C to stop monitoring...');
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
                    
                    // Filter out common transcript placeholders
                    const isBlankContent = !trimmedContent || 
                                         trimmedContent === 'BLANK' || 
                                         trimmedContent === 'blank' ||
                                         trimmedContent === '(blank)' ||
                                         trimmedContent === '[blank]' ||
                                         trimmedContent.match(/^(blank|empty|none)$/i);
                    
                    if (trimmedContent && !isBlankContent) {
                        console.log(`\n📝 New transcript content (${newContent.length} chars):`);
                        console.log(trimmedContent);
                        
                        // Extract control instructions and regular content
                        const { controlInstructions, regularContent } = this.extractControlInstructions(trimmedContent);
                        
                        // Process control instructions immediately
                        for (const controlInstruction of controlInstructions) {
                            console.log(`\n🎛️  Processing control instruction at ${controlInstruction.timestamp}`);
                            await this.processControlInstruction(controlInstruction.instruction);
                        }
                        
                        // Add regular content to pending buffer
                        if (regularContent) {
                            this.pendingContent += ' ' + regularContent;
                            const wordCount = this.pendingContent.trim().split(/\s+/).length;
                            
                            if (this.readOnlyMode) {
                                console.log(`👁️  Read-only: ${wordCount} words accumulated (use SUMMARIZE to process)`);
                            } else {
                                console.log(`📊 Pending content: ${wordCount} words (threshold: ${this.wordThreshold})`);
                                
                                if (wordCount >= this.wordThreshold || !this.currentSummary) {
                                    console.log('\n🤖 Updating summary...');
                                    await this.updateSummary(this.pendingContent.trim());
                                    this.pendingContent = '';
                                } else {
                                    console.log(`⏳ Waiting for more content (need ${this.wordThreshold - wordCount} more words)`);
                                }
                            }
                        }
                        
                        this.lastPosition = stats.size;
                    } else if (trimmedContent && isBlankContent) {
                        console.log(`\n📝 Ignoring blank transcript marker: "${trimmedContent}"`);
                        this.lastPosition = stats.size;
                    }
                });
            }
        } catch (error) {
            console.error('Error processing new content:', error.message);
        }
    }

    async updateSummary(newContent) {
        try {
            // Read existing notes for additional context
            let existingNotes = '';
            try {
                if (fs.existsSync(this.notesFilePath)) {
                    existingNotes = fs.readFileSync(this.notesFilePath, 'utf8').trim();
                }
            } catch (error) {
                console.log('⚠️  Could not read notes file for context');
            }

            const prompt = this.currentSummary 
                ? `You are maintaining an evolving technical meeting summary for a SOFTWARE SOLUTION ARCHITECT. Your task is to UPDATE the existing summary by integrating new content, focusing on technical depth and architectural insights.

CURRENT SUMMARY:
${this.currentSummary}

NEW TRANSCRIPT CONTENT TO ADD:
${newContent}

${existingNotes ? `SUPPLEMENTARY NOTES (for additional context):
${existingNotes}

` : ''}CRITICAL: ONLY SUMMARIZE WHAT WAS EXPLICITLY MENTIONED. DO NOT INVENT OR EXTRAPOLATE.

INSTRUCTIONS FOR ARCHITECT-FOCUSED SUMMARY:
- **Extract Only Explicit Content**: Only include technical details that were specifically mentioned in the transcript
- **Quote Specific Terms**: Use the exact terminology mentioned by speakers
- **No Inference**: Do not infer system architecture, design patterns, or technical details not explicitly discussed
- **No Expansion**: Do not elaborate on brief mentions with assumed technical depth
- **Factual Only**: If only a technology name is mentioned, just note it was mentioned - don't describe its typical use
- **Conservative Approach**: When in doubt, leave it out rather than risk hallucination
- **Verbatim References**: Include actual quotes when capturing technical specifications or decisions

STRUCTURAL REQUIREMENTS:
- Maintain existing section organization and add new sections for new technical domains
- Use **bold headers** for major system components and technical concepts
- Include specific technical details like function names, file paths, configuration values, and version numbers
- Automatically maintain a "Questions for Further Investigation" section with technical clarification needs
- Group related technical concepts together logically
- Do NOT rewrite existing content unless new information contradicts or expands it significantly

ARCHITECT'S PERSPECTIVE:
- Focus on explicitly stated "how" and "why" technical decisions
- Only note risks and opportunities that were specifically discussed
- Document only the integration details and boundaries that were mentioned  
- Capture technical direction only when explicitly stated
- Record tribal knowledge only when actually shared in the meeting

Updated summary:`
                : `You are creating a technical meeting summary for a SOFTWARE SOLUTION ARCHITECT. This is the initial transcript content:

${newContent}

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
            
            // Check if summary needs condensing
            await this.condenseSummaryIfNeeded();
            
            console.log('\n📋 Updated Summary:');
            console.log('='.repeat(50));
            console.log(this.currentSummary);
            console.log('='.repeat(50));
            console.log(`💾 Summary saved to: ${this.summaryFilePath}`);
            
        } catch (error) {
            console.error('Error updating summary:', error.message);
        }
    }

    async stop() {
        fs.unwatchFile(this.filePath);
        
        // Close readline interface
        if (this.rl) {
            this.rl.close();
        }
        
        if (this.pendingContent.trim() && !this.readOnlyMode) {
            console.log('\n🤖 Processing remaining content before stopping...');
            await this.updateSummary(this.pendingContent.trim());
            this.pendingContent = '';
        } else if (this.pendingContent.trim() && this.readOnlyMode) {
            console.log(`\n👁️  ${this.pendingContent.trim().split(/\s+/).length} words of unprocessed content available (was in read-only mode)`);
        }
        
        if (this.currentSummary) {
            this.saveSummary();
            console.log(`\n💾 Final summary saved to: ${this.summaryFilePath}`);
        }
        
        const runtimeHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        console.log('\n🏁 Final Cost Summary:');
        console.log('═'.repeat(50));
        console.log(`📊 Total tokens: ${this.totalInputTokens} in + ${this.totalOutputTokens} out`);
        console.log(`💰 Total cost: $${this.totalCost.toFixed(4)}`);
        console.log(`📞 API requests: ${this.requestCount}`);
        console.log(`⏱️  Session duration: ${(runtimeHours * 60).toFixed(1)} minutes`);
        console.log(`💵 Average cost per hour: $${(this.totalCost / runtimeHours).toFixed(2)}/hour`);
        console.log('═'.repeat(50));
        console.log('\nStopped monitoring transcript file.');
    }
}

function expandPath(filePath) {
    if (filePath.startsWith('~')) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

function main() {
    const filePath = process.argv[2];
    const screenshotsDir = process.argv[3]; // Optional screenshots directory
    
    if (!filePath) {
        console.error('Usage: node index.js <transcript-file-path> [screenshots-directory]');
        process.exit(1);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
        process.exit(1);
    }

    const expandedFilePath = expandPath(filePath);
    const expandedScreenshotsDir = screenshotsDir ? expandPath(screenshotsDir) : null;
    const summarizer = new TranscriptSummarizer(expandedFilePath, expandedScreenshotsDir);
    
    process.on('SIGINT', async () => {
        console.log('\nReceived Ctrl+C, stopping...');
        await summarizer.stop();
        process.exit(0);
    });

    summarizer.start().catch(error => {
        console.error('Error starting summarizer:', error.message);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}