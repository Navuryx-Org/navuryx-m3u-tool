const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const source = path.join(projectRoot, "src");
const output = path.join(projectRoot, "dist");

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
process.stdout.write("Navuryx web assets built in dist\n");
