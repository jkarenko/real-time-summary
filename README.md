# Real-Time Meeting Summary Desktop App

A desktop application that provides real-time AI-powered summarization of meeting transcripts with screenshot integration and advanced note-taking capabilities.

## Features

- **Real-time transcript monitoring** with live updates and follow toggle
- **AI-powered summarization** using Claude Sonnet 4
- **Screenshot integration** with session filtering and selection
- **Interactive timeline** with bracket indicator showing visible content range
- **Context word limit highlighting** with pale yellow visual feedback
- **Smart note generation** with word range tracking and timeline markers
- **Advanced text selection** with word-level precision and visual highlighting
- **Editable notes** with WYSIWYG markdown support and auto-save
- **Professional desktop UI** with responsive layout and virtual scrolling

## Prerequisites

- Node.js (v16 or later)
- ANTHROPIC_API_KEY environment variable set

## Installation

1. Install dependencies:
```bash
npm install
```

2. For development (with DevTools):
```bash
npm run dev
```

3. For production:
```bash
npm start
```

## CLI Mode (Original)

To use the original CLI version:
```bash
npm run cli <transcript-file> [screenshots-directory]
```

## Desktop App Usage

1. **Launch the app**: Run `npm start`
2. **Select transcript file**: Choose your meeting transcript file (.txt, .log)
3. **Select screenshots directory** (optional): Choose folder containing meeting screenshots
4. **Monitor in real-time**: The app will display live transcript updates
5. **Generate notes**: Enter a note header and click "Generate Note"
6. **Use timeline**: Click or drag on timeline to navigate through the meeting
7. **Filter screenshots**: Toggle between session-only and all screenshots

## UI Layout

### Row 1: Main Content
- **Col 1**: Session context input and live transcript display
- **Col 2**: Screenshot gallery, note input, and generate button

### Row 2: Visual Timeline
- Word count markers (0%, 25%, 50%, 75%, 100%)
- Current position cursor
- Note markers (green indicators)
- Selectable ranges

### Row 3: Notes Editor
- Editable markdown notes
- Export and clear functionality
- Auto-save capability

## Keyboard Shortcuts

- `Cmd/Ctrl + S`: Save notes
- `Cmd/Ctrl + N`: Focus note header input
- `Cmd/Ctrl + ,`: Open settings
- `Cmd/Ctrl + Enter`: Generate note (when in note header field)
- `Escape`: Close modals

## Building for Distribution

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build-mac
npm run build-win
npm run build-linux

# Create unpacked directory (for testing)
npm run pack
```

## Project Structure

```
src/
├── main.js          # Electron main process
├── renderer.js      # UI logic and IPC communication
├── preload.js       # Secure API exposure
├── index.html       # App layout
└── styles.css       # UI styling

transcript-summarizer.js  # Core AI logic (shared with CLI)
index.js                  # Original CLI entry point
```

## Development

The app consists of:
1. **Main Process** (`src/main.js`): Integrates with TranscriptSummarizer, handles file operations
2. **Renderer Process** (`src/renderer.js`): Manages UI interactions and real-time updates
3. **Preload Script** (`src/preload.js`): Securely exposes Electron APIs
4. **Core Logic** (`transcript-summarizer.js`): AI summarization engine (shared with CLI)

## Features Comparison

| Feature | CLI | Desktop App |
|---------|-----|-------------|
| Real-time monitoring | ✅ | ✅ |
| AI summarization | ✅ | ✅ |
| Screenshot integration | ✅ | ✅ Enhanced |
| Note generation | ✅ | ✅ Enhanced |
| Visual timeline | ❌ | ✅ |
| Interactive UI | ❌ | ✅ |
| Session management | ❌ | ✅ |
| Export capabilities | ✅ | ✅ Enhanced |

## Configuration

Settings can be configured through the Settings modal:
- **Context Word Limit**: Limit transcript context for AI operations
- **Read-Only Mode**: Toggle automatic summarization
- **Auto-save**: Automatically save notes as you type

## File Outputs

The app creates several files alongside your transcript:
- `*_summary.md`: AI-generated meeting summary
- `*_notes.md`: User-generated notes
- `*_compacted.txt`: Compressed transcript (when using COMPACT command)
- `app-settings.json`: App preferences and window state

## Troubleshooting

1. **App won't start**: Ensure ANTHROPIC_API_KEY is set in environment
2. **No transcript updates**: Check file permissions and that the transcript file exists
3. **Screenshots not loading**: Verify screenshots directory exists and contains image files
4. **High API costs**: Use context word limits and read-only mode to control usage