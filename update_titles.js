const fs = require('fs');
const path = require('path');

const widgetsDir = path.join(process.cwd(), 'client', 'src', 'components', 'AnalyticsWidgets');

function walkDir(dir) {
    let files = [];
    fs.readdirSync(dir).forEach(file => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            files = files.concat(walkDir(fullPath));
        } else if (fullPath.endsWith('.jsx')) {
            files.push(fullPath);
        }
    });
    return files;
}

const files = walkDir(widgetsDir);
let totalUpdated = 0;

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;

    // Replace standard CSS module title classes with global class
    const titleRegex = /className=\{styles\.([a-zA-Z]*[tT]itle)\}/g;
    if (titleRegex.test(content)) {
        content = content.replace(titleRegex, 'className="widget-title"');
        modified = true;
    }

    // specific fix for RSIDistributionWidget inline header
    if (file.includes('RSIDistributionWidget.jsx')) {
        const h3Regex = /<h3 style=\{\{.*\}\}>([\s\S]*?)<\/h3>/g;
        if (h3Regex.test(content)) {
            content = content.replace(h3Regex, '<h3 className="widget-title">\n$1</h3>');
            modified = true;
        }
    }

    if (modified) {
        fs.writeFileSync(file, content, 'utf8');
        console.log('Updated titles in:', path.basename(file));
        totalUpdated++;
    }
});

console.log('Total files updated:', totalUpdated);
