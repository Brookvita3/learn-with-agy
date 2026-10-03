const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error("Usage: node render_svg.js <input.svg> <output.png>");
    process.exit(1);
}

const inputPath = path.resolve(args[0]);
const outputPath = path.resolve(args[1]);

if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

// Try rsvg-convert first
console.log("Attempting to render with rsvg-convert...");
let res = spawnSync('rsvg-convert', ['-z', '2', inputPath, '-o', outputPath], { 
    stdio: 'inherit',
    shell: os.platform() === 'win32'
});

if (res.status === 0 && fs.existsSync(outputPath)) {
    console.log(`Successfully rendered to ${outputPath} via rsvg-convert`);
    process.exit(0);
}

// Fallback to ImageMagick
console.log("rsvg-convert failed or not found, falling back to ImageMagick (magick)...");
res = spawnSync('magick', ['-density', '192', '-background', 'white', inputPath, outputPath], { 
    stdio: 'inherit',
    shell: os.platform() === 'win32'
});

if (res.status === 0 && fs.existsSync(outputPath)) {
    console.log(`Successfully rendered to ${outputPath} via magick`);
    process.exit(0);
}

console.error(`SVG render failed. Ensure either rsvg-convert or ImageMagick (magick) is installed on your system.`);
process.exit(1);
