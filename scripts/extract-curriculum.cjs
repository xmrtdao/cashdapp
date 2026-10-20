// Extract CURRICULUM from the runtime build xmrt-university.mjs (already-valid JS)
const fs = require('fs');
const src = fs.readFileSync('C:/Users/PureTrek/Desktop/xmrtdao/suite/runtime/build/xmrt-university.mjs', 'utf8');
const start = src.indexOf('var CURRICULUM');
const arr = src.indexOf('=', start);
const endmark = src.indexOf('function evaluateQuiz', arr);
let block = src.slice(arr+1, endmark);
fs.writeFileSync('C:/Users/PureTrek/AppData/Local/Temp/curriculum-build.js', 'module.exports = ' + block + ';');
const mod = require('C:/Users/PureTrek/AppData/Local/Temp/curriculum-build.js');
const cur = Array.isArray(mod) ? mod : (mod.default || mod);
console.log(JSON.stringify(cur));
