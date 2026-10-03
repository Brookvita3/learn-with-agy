const fs = require('fs');
const path = require('path');

const eventMode = process.argv[2] || 'auto';

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    let payload = {};
    try {
        if (input.trim()) {
            payload = JSON.parse(input);
        }
    } catch (e) {}

    const isPreTool = eventMode === 'pre-tool' || (eventMode === 'auto' && !!payload.toolCall);

    try {
        if (payload.transcriptPath) {
            const defaultRoot = path.resolve(__dirname, '../..');
            const workspaceRoot = (payload.workspacePaths && payload.workspacePaths[0]) ? payload.workspacePaths[0] : defaultRoot;
            syncSession(payload, workspaceRoot, isPreTool);
        }
    } catch (e) {
        // Silent catch for hook reliability
    } finally {
        if (isPreTool) {
            console.log(JSON.stringify({ decision: "allow" }));
        } else {
            console.log(JSON.stringify({}));
        }
    }
});

function getFullContent(entry, transcriptPath, lineIdx) {
    if (entry && entry.truncated_fields && entry.truncated_fields.includes('content') && transcriptPath) {
        const fullPath = transcriptPath.replace(/transcript\.jsonl$/, 'transcript_full.jsonl');
        if (fs.existsSync(fullPath)) {
            try {
                const fullLines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(l => l.trim() !== '');
                if (fullLines[lineIdx]) {
                    const fullEntry = JSON.parse(fullLines[lineIdx]);
                    if (fullEntry.content) return fullEntry.content;
                }
            } catch (e) {}
        }
    }
    return (entry && entry.content) ? entry.content : '';
}

function cleanUserContent(raw) {
    if (!raw) return '';
    const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
    let text = match ? match[1] : raw;
    text = text.replace(/<[^>]+>/g, '').trim();
    if (text.startsWith('/plan') && text.length < 10) return '';
    return text;
}

function extractTopicFromPrompt(text) {
    if (!text) return 'Lesson';
    let s = text.trim();
    // Strip leading slash commands like /teach, /plan
    s = s.replace(/^\/(?:teach|plan|goal|grill-me)\s+/i, '');

    // Handle "i want to learn Java" -> "learn Java"
    if (/^i\s+want\s+to\s+learn\s+/i.test(s)) {
        s = s.replace(/^i\s+want\s+to\s+learn\s+(?:about\s+)?/i, '');
        if (!/^learn\s+/i.test(s) && s.split(' ').length <= 2) {
            s = 'learn ' + s;
        }
    }

    const prefixes = [
        /^teach\s+me\s+(?:about\s+)?/i,
        /^can\s+you\s+teach\s+me\s+(?:about\s+)?/i,
        /^help\s+me\s+understand\s+(?:about\s+)?/i,
        /^how\s+does\s+(.+?)\s+work\??$/i,
        /^what\s+is\s+(?:a\s+|the\s+)?(.+?)\??$/i,
        /^explain\s+(?:to\s+me\s+)?(?:about\s+)?/i
    ];
    for (const p of prefixes) {
        const m = p.exec(s);
        if (m) {
            s = m[1] || s.replace(p, '');
            break;
        }
    }

    // Strip trailing caveats like ", i have basic knowledge"
    s = s.split(/[,;\n\.]/)[0].trim();
    s = s.replace(/\s+(?:from\s+scratch|step\s+by\s+step|in\s+depth|for\s+beginners).*$/i, '').trim();
    // Clean invalid characters for filenames
    s = s.replace(/[\/\\:*?"<>|]/g, '-').trim();
    s = s.replace(/\s+/g, ' ');

    if (!s || s.length < 2) return 'Lesson';
    return s;
}

function parseQuestions(raw) {
    if (!raw) return [];
    let q = raw;
    if (typeof q === 'string') {
        try { q = JSON.parse(q); } catch (e) { return []; }
    }
    if (Array.isArray(q)) return q;
    if (q && Array.isArray(q.questions)) return q.questions;
    if (q && typeof q.questions === 'string') {
        try { return JSON.parse(q.questions); } catch (e) { return []; }
    }
    return [];
}

function checkIsTeachSession(transcriptPath, payload) {
    if (fs.existsSync(transcriptPath)) {
        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim() !== '');
        for (const line of lines) {
            try {
                const e = JSON.parse(line);
                if (e.type === 'USER_INPUT') {
                    const raw = e.content || '';
                    if (/\/teach\b/i.test(raw) || /invoked the \(teach\) skill/i.test(raw) || /name=["']teach["']/i.test(raw)) {
                        return true;
                    }
                    return false;
                }
            } catch (err) {}
        }
    }
    if (payload && payload.userMessage) {
        return /\/teach\b/i.test(payload.userMessage);
    }
    return false;
}

function syncSession(payload, workspaceRoot, isPreTool) {
    const transcriptPath = payload.transcriptPath;
    const conversationId = payload.conversationId;
    const stepIdx = payload.stepIdx;

    const stateFile = path.join(workspaceRoot, '.agents', '.session_state.json');
    let state = { sessions: {} };
    if (fs.existsSync(stateFile)) {
        try {
            state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
        } catch (e) {}
    }

    const sessionKey = conversationId || Buffer.from(transcriptPath).toString('hex').substring(0, 16);
    state.sessions = state.sessions || {};
    const sessionState = state.sessions[sessionKey] || { 
        lastStep: -1, 
        targetFile: null,
        loggedQuestions: [], 
        loggedAnswers: [] 
    };
    sessionState.loggedQuestions = sessionState.loggedQuestions || [];
    sessionState.loggedAnswers = sessionState.loggedAnswers || [];

    // Only log sessions that start with /teach or invoke the teach skill
    if (sessionState.isTeachSession === undefined) {
        sessionState.isTeachSession = checkIsTeachSession(transcriptPath, payload);
    }
    if (!sessionState.isTeachSession) {
        state.sessions[sessionKey] = sessionState;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        return;
    }

    // Determine target file for this session if not already assigned
    if (!sessionState.targetFile) {
        let firstPrompt = '';
        if (fs.existsSync(transcriptPath)) {
            const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim() !== '');
            for (const line of lines) {
                try {
                    const e = JSON.parse(line);
                    if (e.type === 'USER_INPUT') {
                        const cleaned = cleanUserContent(e.content);
                        if (cleaned) {
                            firstPrompt = cleaned;
                            break;
                        }
                    }
                } catch (err) {}
            }
        }
        const topic = extractTopicFromPrompt(firstPrompt);
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = String(now.getFullYear());
        const safeTopic = topic.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').replace(/-+/g, '-');
        const fileName = `${dd}-${mm}-${yyyy}-${safeTopic}.md`;
        sessionState.targetFile = path.join('lesson', fileName);
    }

    const targetFile = path.resolve(workspaceRoot, sessionState.targetFile);
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    // Initialize document with frontmatter if it does not exist
    if (!fs.existsSync(targetFile) || fs.readFileSync(targetFile, 'utf8').trim() === '') {
        const now = new Date();
        const dateStr = now.toISOString().replace('T', ' ').substring(0, 10);
        const titleName = path.basename(sessionState.targetFile, '.md');
        const initial = `---
title: "${titleName}"
date: ${dateStr}
tags:
  - learning-log
  - study-session
---

# ${titleName}

`;
        fs.writeFileSync(targetFile, initial, 'utf8');
    }

    let newBlocks = [];

    // 1. Sync User input and previous entries from transcript.jsonl
    if (fs.existsSync(transcriptPath)) {
        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim() !== '');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let entry;
            try { entry = JSON.parse(line); } catch (e) { continue; }

            if (entry.step_index <= sessionState.lastStep) continue;

            if (entry.type === 'USER_INPUT') {
                const userText = cleanUserContent(entry.content);
                if (userText) {
                    newBlocks.push(`---\n\n## 💬 You\n\n> [!quote]\n> ${userText.split('\n').join('\n> ')}`);
                }
                sessionState.lastStep = Math.max(sessionState.lastStep, entry.step_index);
            }
            else if (entry.type === 'PLANNER_RESPONSE') {
                const content = getFullContent(entry, transcriptPath, i);
                if (content) {
                    const assistantText = content.trim();
                    if (assistantText) {
                        newBlocks.push(assistantText);
                    }
                }
                // Check if ask_question was called in transcript (immediate question logging)
                if (entry.tool_calls) {
                    for (const call of entry.tool_calls) {
                        if (call.name === 'ask_question') {
                            const qs = parseQuestions(call.args || call.arguments);
                            for (const q of qs) {
                                if (q && q.question && !sessionState.loggedQuestions.includes(q.question)) {
                                    let block = `> [!question] Checkpoint Question\n> **${q.question}**`;
                                    if (q.options && q.options.length > 0) {
                                        block += '\n>\n' + q.options.map((o, idx) => `> - **${idx + 1}.** ${o}`).join('\n');
                                    }
                                    newBlocks.push(block);
                                    sessionState.loggedQuestions.push(q.question);
                                }
                            }
                        }
                    }
                }
                sessionState.lastStep = Math.max(sessionState.lastStep, entry.step_index);
            }
            else if (entry.type === 'GENERIC') {
                // User answers to ask_question modal
                const content = getFullContent(entry, transcriptPath, i);
                if (content && (content.includes('A1:') || content.includes('A2:'))) {
                    const answerLines = content.split('\n').map(l => l.trim()).filter(l => /^A\d+:/.test(l));
                    const ansKey = answerLines.join('|');
                    if (answerLines.length > 0 && !sessionState.loggedAnswers.includes(ansKey)) {
                        if (answerLines.every(l => l.includes('User Skipped'))) {
                            newBlocks.push(`> [!warning] Your Answer\n> *(User Skipped)*`);
                        } else {
                            newBlocks.push(`> [!check] Your Answer\n> ${answerLines.map(l => '- **' + l.substring(0, 3) + '** ' + l.substring(3).trim()).join('\n> ')}`);
                        }
                        sessionState.loggedAnswers.push(ansKey);
                    }
                }
                sessionState.lastStep = Math.max(sessionState.lastStep, entry.step_index);
            }
            else {
                sessionState.lastStep = Math.max(sessionState.lastStep, entry.step_index);
            }
        }
    }

    // 2. PreToolUse: write the question immediately as soon as ask_question is called (if not in transcript yet)
    if (isPreTool && payload.toolCall && payload.toolCall.name === 'ask_question') {
        const qs = parseQuestions(payload.toolCall.args);
        for (const q of qs) {
            if (q && q.question && !sessionState.loggedQuestions.includes(q.question)) {
                let block = `> [!question] Checkpoint Question\n> **${q.question}**`;
                if (q.options && q.options.length > 0) {
                    block += '\n>\n' + q.options.map((o, i) => `> - **${i + 1}.** ${o}`).join('\n');
                }
                newBlocks.push(block);
                sessionState.loggedQuestions.push(q.question);
            }
        }
    }

    // 3. PostToolUse: capture answer immediately from output.txt if not in transcript yet
    if (!isPreTool && stepIdx !== undefined && transcriptPath) {
        const stepOutputDir = path.resolve(path.dirname(transcriptPath), '../steps', String(stepIdx));
        const stepOutputFile = path.join(stepOutputDir, 'output.txt');
        if (fs.existsSync(stepOutputFile)) {
            const outContent = fs.readFileSync(stepOutputFile, 'utf8');
            if (outContent.includes('A1:') || outContent.includes('A2:')) {
                const answerLines = outContent.split('\n').map(l => l.trim()).filter(l => /^A\d+:/.test(l));
                const ansKey = answerLines.join('|');
                if (answerLines.length > 0 && !sessionState.loggedAnswers.includes(ansKey)) {
                    if (answerLines.every(l => l.includes('User Skipped'))) {
                        newBlocks.push(`> [!warning] Your Answer\n> *(User Skipped)*`);
                    } else {
                        newBlocks.push(`> [!check] Your Answer\n> ${answerLines.map(l => '- **' + l.substring(0, 3) + '** ' + l.substring(3).trim()).join('\n> ')}`);
                    }
                    sessionState.loggedAnswers.push(ansKey);
                    sessionState.lastStep = Math.max(sessionState.lastStep, stepIdx);
                }
            }
        }
    }

    if (newBlocks.length > 0) {
        fs.appendFileSync(targetFile, '\n\n' + newBlocks.join('\n\n\n') + '\n', 'utf8');
    }
    state.sessions[sessionKey] = sessionState;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}
