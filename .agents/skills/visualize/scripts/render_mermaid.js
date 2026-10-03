const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Cross-platform Chrome discovery
const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

function findChrome() {
    for (const c of CHROME_CANDIDATES) {
        if (fs.existsSync(c)) return c;
    }
    return undefined;
}

function renderMermaid(inputPath, outputPath) {
    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        return false;
    }

    // Ensure output dir exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    let mmdcPath = path.resolve(__dirname, '../../../node_modules/.bin/mmdc');
    if (!fs.existsSync(mmdcPath)) {
        mmdcPath = path.resolve(__dirname, '../../../../node_modules/.bin/mmdc');
    }
    if (!fs.existsSync(mmdcPath) && os.platform() === 'win32') {
        mmdcPath = mmdcPath + '.cmd';
    }

    const cmd = fs.existsSync(mmdcPath) ? mmdcPath : 'npx';
    const cmdArgs = fs.existsSync(mmdcPath) ? [] : ['-y', '@mermaid-js/mermaid-cli'];

    const chrome = findChrome();
    const configPath = path.resolve(os.tmpdir(), `puppeteer-config-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);
    const config = chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] };
    fs.writeFileSync(configPath, JSON.stringify(config));

    // Default to SVG or PNG depending on extension
    const isSvg = outputPath.endsWith('.svg');
    cmdArgs.push('-i', inputPath, '-o', outputPath, '-p', configPath);
    if (!isSvg) {
        cmdArgs.push('-s', '2', '-b', 'white');
    } else {
        cmdArgs.push('-b', 'transparent');
    }

    console.log(`Rendering ${path.basename(inputPath)} -> ${path.basename(outputPath)}...`);

    const result = spawnSync(cmd, cmdArgs, { 
        stdio: 'inherit',
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
        shell: os.platform() === 'win32'
    });

    try { fs.unlinkSync(configPath); } catch (e) {}

    if (result.error || result.status !== 0) {
        console.error(`Failed to render mermaid diagram.`);
        return false;
    }

    console.log(`Successfully rendered to ${outputPath}`);
    return true;
}

// Function to extract and render all mermaid blocks from a markdown note
function extractAndRenderFromMarkdown(markdownFile, vizDir) {
    if (!fs.existsSync(markdownFile)) {
        console.error(`Markdown file not found: ${markdownFile}`);
        return;
    }

    if (!fs.existsSync(vizDir)) {
        fs.mkdirSync(vizDir, { recursive: true });
    }

    const content = fs.readFileSync(markdownFile, 'utf8');
    const regex = /```mermaid\s*([\s\S]*?)```/g;
    let match;
    let index = 1;
    const baseSlug = path.basename(markdownFile, path.extname(markdownFile)).toLowerCase().replace(/[^a-z0-9]+/g, '-');

    while ((match = regex.exec(content)) !== null) {
        const diagramCode = match[1].trim();
        const tmpMmd = path.join(vizDir, `staging-extract-${index}.mmd`);
        const outSvg = path.join(vizDir, `viz-${baseSlug}-diagram-${index}.svg`);
        
        fs.writeFileSync(tmpMmd, diagramCode, 'utf8');
        console.log(`\nFound Mermaid diagram #${index}:`);
        const ok = renderMermaid(tmpMmd, outSvg);
        try { fs.unlinkSync(tmpMmd); } catch (e) {}
        
        if (ok) {
            console.log(`Saved diagram as: ${outSvg}`);
            console.log(`Obsidian embed tag: ![[${path.basename(outSvg)}|600]]`);
        }
        index++;
    }

    if (index === 1) {
        console.log("No ```mermaid blocks found in the document.");
    }
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.log("Usage:");
    console.log("  node render_mermaid.js <input.mmd> <output.svg|output.png>");
    console.log("  node render_mermaid.js --extract <file.md> [viz-folder]");
    process.exit(1);
}

if (args[0] === '--extract') {
    const mdFile = path.resolve(args[1]);
    const vizFolder = args[2] ? path.resolve(args[2]) : path.resolve(path.dirname(mdFile), 'viz');
    extractAndRenderFromMarkdown(mdFile, vizFolder);
    process.exit(0);
}

const inputPath = path.resolve(args[0]);
let outputPath = args[1] ? path.resolve(args[1]) : inputPath.replace(/\.mmd$/, '.svg');
if (!outputPath.endsWith('.svg') && !outputPath.endsWith('.png')) {
    outputPath += '.svg'; // default to SVG
}

const success = renderMermaid(inputPath, outputPath);
process.exit(success ? 0 : 1);
