#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');

class TranscriptSummarizer {
    constructor(filePath) {
        this.filePath = filePath;
        this.summaryFilePath = this.getSummaryFilePath(filePath);
        this.lastPosition = 0;
        this.currentSummary = '';
        this.pendingContent = '';
        this.wordThreshold = 100;
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
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

    async start() {
        console.log(`Monitoring transcript file: ${this.filePath}`);
        console.log(`Summary will be saved to: ${this.summaryFilePath}`);
        
        if (!fs.existsSync(this.filePath)) {
            console.error(`File does not exist: ${this.filePath}`);
            process.exit(1);
        }

        this.loadExistingSummary();
        this.lastPosition = fs.statSync(this.filePath).size;
        console.log(`Starting from position: ${this.lastPosition}`);

        fs.watchFile(this.filePath, { interval: 1000 }, async (curr, prev) => {
            if (curr.mtime > prev.mtime) {
                await this.processNewContent();
            }
        });

        console.log('Press Ctrl+C to stop monitoring...');
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
                    if (newContent.trim()) {
                        console.log(`\n📝 New transcript content (${newContent.length} chars):`);
                        console.log(newContent.trim());
                        
                        this.pendingContent += ' ' + newContent.trim();
                        const wordCount = this.pendingContent.trim().split(/\s+/).length;
                        
                        console.log(`📊 Pending content: ${wordCount} words (threshold: ${this.wordThreshold})`);
                        
                        if (wordCount >= this.wordThreshold || !this.currentSummary) {
                            console.log('\n🤖 Updating summary...');
                            await this.updateSummary(this.pendingContent.trim());
                            this.pendingContent = '';
                        } else {
                            console.log(`⏳ Waiting for more content (need ${this.wordThreshold - wordCount} more words)`);
                        }
                        
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
                ? `You are maintaining an evolving summary of a real-time meeting transcript. Your task is to UPDATE the existing summary by integrating new content, NOT to rewrite it from scratch.

CURRENT SUMMARY:
${this.currentSummary}

NEW TRANSCRIPT CONTENT TO ADD:
${newContent}

INSTRUCTIONS:
- Add the new information to the appropriate sections of the existing summary
- If new topics are introduced, add them as new sections
- Maintain the existing structure and content
- Only modify what needs to be updated based on the new content
- Do NOT rewrite or restructure the entire summary
- Do NOT add meta-commentary about updating or maintaining structure
- Return the complete updated summary with both old and new information integrated

Updated summary:`
                : `You are creating a summary of a real-time meeting transcript. Here is the first portion of transcript content:

${newContent}

Please create an initial summary that captures the key points, topics discussed, and any important decisions or action items mentioned.`;

            const message = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            });

            this.currentSummary = message.content[0].text;
            this.saveSummary();
            
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
        
        if (this.pendingContent.trim()) {
            console.log('\n🤖 Processing remaining content before stopping...');
            await this.updateSummary(this.pendingContent.trim());
            this.pendingContent = '';
        }
        
        if (this.currentSummary) {
            this.saveSummary();
            console.log(`\n💾 Final summary saved to: ${this.summaryFilePath}`);
        }
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