#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

class TranscriptSummarizer {
    constructor(filePath) {
        this.filePath = filePath;
        this.summaryFilePath = this.getSummaryFilePath(filePath);
        this.lastPosition = 0;
        this.currentSummary = '';
        this.pendingContent = '';
        this.wordThreshold = 200;
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
    }

    getSummaryFilePath(transcriptPath) {
        const dir = path.dirname(transcriptPath);
        const basename = path.basename(transcriptPath, path.extname(transcriptPath));
        return path.join(dir, `${basename}_summary.txt`);
    }

    loadExistingSummary() {
        if (fs.existsSync(this.summaryFilePath)) {
            this.currentSummary = fs.readFileSync(this.summaryFilePath, 'utf8').trim();
            console.log(`📋 Loaded existing summary from: ${this.summaryFilePath}`);
            return true;
        }
        return false;
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
        console.log('─'.repeat(50));
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
            
            // Use the initial summary prompt (not the update prompt)
            const prompt = `You are creating a technical meeting summary for a SOFTWARE SOLUTION ARCHITECT. This is the complete transcript content:

${cleanTranscript}

CRITICAL: ONLY SUMMARIZE WHAT WAS EXPLICITLY MENTIONED. DO NOT INVENT OR EXTRAPOLATE.

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
            
            console.log('\n🔄 SUMMARY REGENERATED FROM FULL TRANSCRIPT');
            console.log('═'.repeat(60));
            console.log(this.currentSummary);
            console.log('═'.repeat(60));
            console.log(`💾 Fresh summary saved to: ${this.summaryFilePath}`);
            console.log(`📍 Position reset to end of file: ${this.lastPosition}`);
            
            this.displayCostReport(requestCost, inputTokens, outputTokens);

        } catch (error) {
            console.error('Error regenerating summary from full transcript:', error.message);
        }
    }

    setupTextControlChannel() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: ''
        });

        this.rl.on('line', async (input) => {
            const instruction = input.trim();
            if (instruction) {
                if (instruction.toUpperCase() === 'REGENERATE') {
                    console.log(`\n🔄 REGENERATING SUMMARY FROM ENTIRE TRANSCRIPT`);
                    console.log('⏳ Reading full transcript file and rebuilding summary...\n');
                    await this.regenerateFromFullTranscript();
                    console.log('\n💬 Ready for next instruction (or continue with meeting)');
                } else {
                    console.log(`\n⌨️  PROCESSING TEXT CONTROL: "${instruction}"`);
                    console.log('⏳ Applying instruction to summary...\n');
                    await this.processControlInstruction(instruction);
                    console.log('\n💬 Ready for next instruction (or continue with meeting)');
                }
            }
        });

        // Initially hide the prompt until first instruction is needed
        console.log('\n💬 Text Control Channel: Type instructions and press Enter');
        console.log('   Example: "Split the payment section into two separate topics"');
        console.log('   Special: Type "REGENERATE" to rebuild summary from entire transcript');
    }

    async start() {
        console.log(`Monitoring transcript file: ${this.filePath}`);
        console.log(`Summary will be saved to: ${this.summaryFilePath}`);
        console.log(`🎛️  Control channel: Say "${this.controlTrigger}" as "${this.controlSpeaker}" to send instructions`);
        
        if (!fs.existsSync(this.filePath)) {
            console.error(`File does not exist: ${this.filePath}`);
            process.exit(1);
        }

        this.loadExistingSummary();
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
                            
                            console.log(`📊 Pending content: ${wordCount} words (threshold: ${this.wordThreshold})`);
                            
                            if (wordCount >= this.wordThreshold || !this.currentSummary) {
                                console.log('\n🤖 Updating summary...');
                                await this.updateSummary(this.pendingContent.trim());
                                this.pendingContent = '';
                            } else {
                                console.log(`⏳ Waiting for more content (need ${this.wordThreshold - wordCount} more words)`);
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
            const prompt = this.currentSummary 
                ? `You are maintaining an evolving technical meeting summary for a SOFTWARE SOLUTION ARCHITECT. Your task is to UPDATE the existing summary by integrating new content, focusing on technical depth and architectural insights.

CURRENT SUMMARY:
${this.currentSummary}

NEW TRANSCRIPT CONTENT TO ADD:
${newContent}

CRITICAL: ONLY SUMMARIZE WHAT WAS EXPLICITLY MENTIONED. DO NOT INVENT OR EXTRAPOLATE.

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

CRITICAL: ONLY SUMMARIZE WHAT WAS EXPLICITLY MENTIONED. DO NOT INVENT OR EXTRAPOLATE.

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
        
        if (this.pendingContent.trim()) {
            console.log('\n🤖 Processing remaining content before stopping...');
            await this.updateSummary(this.pendingContent.trim());
            this.pendingContent = '';
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
    
    if (!filePath) {
        console.error('Usage: node index.js <transcript-file-path>');
        process.exit(1);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('Error: ANTHROPIC_API_KEY environment variable is not set');
        process.exit(1);
    }

    const expandedFilePath = expandPath(filePath);
    const summarizer = new TranscriptSummarizer(expandedFilePath);
    
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