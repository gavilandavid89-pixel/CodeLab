const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/validate.yml'), 'utf8');
const expected = pkg.version;

assert.ok(html.includes('<title>CodeLab XD Studio Pro v' + expected + '</title>'),
  'Visible page title should match package.json version');
assert.ok(app.includes("const APP_VERSION = '" + expected + "';"),
  'Client APP_VERSION should match package.json version');
assert.ok(server.includes("const APP_VERSION = '" + expected + "';"),
  'Server APP_VERSION should match package.json version');
assert.ok(readme.includes('# CodeLab XD Studio Pro v' + expected),
  'README heading should match package.json version');
assert.match(readme, /Node\.js 22\.17\.0 o superior/,
  'README should document the minimum supported Node.js version');
assert.match(workflow, /node-version:\s*["']?22\.17\.0/,
  'Main validation workflow should use the declared minimum Node.js version');
assert.equal(pkg.engines.node, '>=22.17.0',
  'package.json should declare the documented minimum Node.js version');
assert.ok(!readme.includes('Cero dependencias npm'),
  'README must not claim the project has zero npm dependencies');

console.log('Version consistency passed: package, page title, client, and server all use v' + expected + '.');
