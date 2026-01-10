const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');

// --- NEW: ADD CUSTOM FORMATTER ---
carbone.formatters.showWithLabel = function (value, label) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    return label + ' ' + value;
};
// --- END OF NEW FORMATTER ---


const FormData = require('form-data');
const yauzl = require('yauzl');
const yazl = require('yazl');
const sharp = require('sharp');
const xml2js = require('xml2js');
const { PDFDocument, rgb } = require('pdf-lib');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);
const parseXml = util.promisify(xml2js.parseString);

// --- HELPER FUNCTION ---
function applyNamingConvention(data, convention) {
    if (!convention || typeof data !== 'object' || data === null) {
        if (typeof data === 'string') {
            switch (convention.toLowerCase()) {
                case 'uppercase':
                    return data.toUpperCase();
                case 'lowercase':
                    return data.toLowerCase();
                case 'capitalize':
                    return data.replace(/\b\w/g, char => char.toUpperCase());
                default:
                    return data;
            }
        }
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => applyNamingConvention(item, convention));
    }

    const newObj = {};
    for (const key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            newObj[key] = applyNamingConvention(data[key], convention);
        }
    }
    return newObj;
}


// --- UTILITY FUNCTIONS ---
async function updateJobHistory(jobId, schoolId, payload) {
    try {
        const jobUpdatePayload = {
            _school: schoolId,
            table: 'job_history',
            _uid: jobId,
            payload: payload
        };
        const jobUpdateRes = await fetch("https://demoschool.edusparsh.com/api/updatejobHistory", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jobUpdatePayload),
        });
        if (!jobUpdateRes.ok) {
            console.error(`⚠️ Could not update job_history: ${jobUpdateRes.statusText}`);
        }
    } catch (apiError) {
        console.error("⚠️ Error while updating job_history API.", apiError);
    }
}

async function downloadFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
}

async function convertOdtToPdf(odtPath, outputDir) {
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${odtPath}"`;
    try {
        console.log(`🔄 Running conversion for: ${path.basename(odtPath)}`);
        const { stdout, stderr } = await execPromise(command);
        if (stderr) console.warn(`[LibreOffice STDERR]:`, stderr);
        return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
    } catch (error) {
        console.error(`❌ LibreOffice conversion failed for ${path.basename(odtPath)}.`);
        throw new Error(`LibreOffice conversion failed.`);
    }
}

async function addWhiteOverlay(inputPdfPath, outputPdfPath, options = {}) {
    const { heightCm = 5, topMarginCm = 0, leftMarginCm = 0, rightMarginCm = 0 } = options;
    console.log(`🎨 Adding white overlay to ${path.basename(inputPdfPath)}`);
    try {
        const POINTS_PER_CM = 28.3465;
        const overlayHeight = heightCm * POINTS_PER_CM;
        const topMargin = topMarginCm * POINTS_PER_CM;
        const leftMargin = leftMarginCm * POINTS_PER_CM;
        const rightMargin = rightMarginCm * POINTS_PER_CM;

        const existingPdfBytes = await fs.readFile(inputPdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();

        for (const page of pages) {
            const { width: pageWidth, height: pageHeight } = page.getSize();
            const rectX = leftMargin;
            const rectY = pageHeight - topMargin - overlayHeight;
            const rectWidth = pageWidth - leftMargin - rightMargin;

            if (rectWidth < 0) continue;

            page.drawRectangle({
                x: rectX, y: rectY, width: rectWidth, height: overlayHeight,
                color: rgb(1, 1, 1), borderWidth: 0,
            });
        }
        const pdfBytes = await pdfDoc.save();
        await fs.writeFile(outputPdfPath, pdfBytes);
        console.log(`✅ Overlay added successfully.`);
    } catch (error) {
        console.error(`❌ Failed to add white overlay:`, error);
        await fs.copyFile(inputPdfPath, outputPdfPath);
    }
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

async function compressPdf(inputPath, outputPath) {
    const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
    try {
        console.log(`🗜️  Compressing PDF...`);
        await execPromise(command);
    } catch (error) {
        console.error(`❌ Compression failed.`);
        throw error;
    }
}

async function fetchImage(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return await sharp(buffer).toFormat('png').toBuffer();
    } catch (err) {
        console.warn("⚠️ Could not fetch photo:", url);
        return null;
    }
}

async function waitForFile(filePath, retries = 5, delay = 100) {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.access(filePath);
            return true;
        } catch (err) {
            if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay));
            else throw err;
        }
    }
    return false;
}

async function findImageFilename(contentXmlPath, picturesDir, frameName) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsedXml = await parseXml(contentXml, { explicitArray: false, mergeAttrs: true });

        function findFrames(node) {
            let frames = [];
            if (typeof node !== 'object' || node === null) return frames;
            if (node['draw:frame']) {
                frames.push(...(Array.isArray(node['draw:frame']) ? node['draw:frame'] : [node['draw:frame']]));
            }
            for (const key in node) {
                if (typeof node[key] === 'object') frames.push(...findFrames(node[key]));
            }
            return frames;
        }

        const frames = findFrames(parsedXml['office:document-content']?.['office:body']?.['office:text'] || {});
        for (const frame of frames) {
            if (frame['draw:name'] === frameName && frame['draw:image']) {
                const href = frame['draw:image']['xlink:href'];
                if (href && href.startsWith('Pictures/')) {
                    const filename = href.replace('Pictures/', '');
                    return filename;
                }
            }
        }
        return null;
    } catch (err) {
        return null;
    }
}

async function replaceImageInOdt(templatePath, student, schoolDetails, tempDir) {
    const studentDir = path.join(tempDir, `student_${student.student_id}`);
    await fs.mkdir(studentDir, { recursive: true });

    // Unzip ODT
    await new Promise((resolve, reject) => {
        yauzl.open(templatePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', async (entry) => {
                const entryPath = path.join(studentDir, entry.fileName);
                if (/\/$/.test(entry.fileName)) {
                    await fs.mkdir(entryPath, { recursive: true });
                    zipfile.readEntry();
                } else {
                    zipfile.openReadStream(entry, async (err, readStream) => {
                        if (err) return reject(err);
                        await fs.mkdir(path.dirname(entryPath), { recursive: true });
                        const writeStream = require('fs').createWriteStream(entryPath);
                        readStream.pipe(writeStream);
                        readStream.on('end', () => zipfile.readEntry());
                        readStream.on('error', reject);
                    });
                }
            });
            zipfile.on('end', () => resolve());
            zipfile.on('error', reject);
        });
    });

    const contentXmlPath = path.join(studentDir, 'content.xml');
    const picturesDir = path.join(studentDir, 'Pictures');
    await fs.mkdir(picturesDir, { recursive: true });

    // =========================================================================
    // 🔧 AUTO-FIX TEMPLATE TAGS 🔧
    // This block reads the template XML and injects '[i]' into array paths
    // where it is missing (e.g., converts {d.subjects.groups} to {d.subjects[i].groups}).
    // This fixes the blank table issue without editing the ODT file.
    // =========================================================================
    try {
        let contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const originalContent = contentXml;

        // Replace "d.subjects." with "d.subjects[i]." ONLY if it's NOT already followed by "["
        contentXml = contentXml.replace(/d\.(subjects|coScholastic)\.(?=[a-zA-Z])/g, 'd.$1[i].');

        // Also fix singular typo "d.subject." to "d.subjects[i]."
        contentXml = contentXml.replace(/d\.subject\.(?=[a-zA-Z])/g, 'd.subjects[i].');

        if (contentXml !== originalContent) {
            await fs.writeFile(contentXmlPath, contentXml);
            console.log(`🔧 Auto-corrected template tags for ${student.full_name} (injected [i] iterator).`);
        }
    } catch (err) {
        console.warn(`⚠️ Failed to auto-fix template tags: ${err.message}`);
    }
    // =========================================================================

    // Image Replacement Logic
    const imageReplacements = [
        { frameName: 'Logo', url: schoolDetails.logo },
        { frameName: 'studentImage', url: student.photo }
    ];

    if (schoolDetails.signatures) {
        for (const key in schoolDetails.signatures) {
            if (schoolDetails.signatures[key]?.url) {
                imageReplacements.push({ frameName: key, url: schoolDetails.signatures[key].url });
            }
        }
    }

    for (const replacement of imageReplacements) {
        if (!replacement.url || !replacement.url.startsWith("http")) continue;
        const targetFilename = await findImageFilename(contentXmlPath, picturesDir, replacement.frameName);
        if (!targetFilename) continue;

        const imageBuffer = await fetchImage(replacement.url);
        if (imageBuffer) {
            await fs.writeFile(path.join(picturesDir, targetFilename), imageBuffer);
            console.log(`✅ Replaced image: ${replacement.frameName}`);
        }
    }

    // ❌ REMOVED XMLLINT FORMATTING TO PREVENT BREAKING CARBONE TAGS ❌

    // Re-zip
    const safeName = student.full_name?.replace(/\s+/g, '_') || student.student_id;
    const newOdtPath = path.join(tempDir, `${safeName}.odt`);
    const zip = new yazl.ZipFile();
    const walkDir = async (dir, zipPath = '') => {
        const files = await fs.readdir(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stats = await fs.stat(fullPath);
            const zipEntry = path.join(zipPath, file);
            if (stats.isDirectory()) await walkDir(fullPath, zipEntry);
            else zip.addFile(fullPath, zipEntry);
        }
    };

    await walkDir(studentDir);
    const writeStream = require('fs').createWriteStream(newOdtPath);
    zip.outputStream.pipe(writeStream);
    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        zip.end();
    });

    return newOdtPath;
}

function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) return '';
    if (Array.isArray(data)) return data.map(item => cleanData(item));
    if (typeof data === 'object') {
        const cleaned = {};
        for (const key in data) {
            cleaned[key] = (data[key] === 'NaN') ? '' : cleanData(data[key]);
        }
        return cleaned;
    }
    return data;
}

// --- MAIN FUNCTION ---
async function GenerateOdtFile() {
    let outputDir = '', tempDir = '';
    const jobId = process.env.JOB_ID;
    const schoolId = process.env.SCHOOL_ID;

    try {
        console.log("🚀 Starting dynamic marksheet generation...");

        // ... (Environment Variable Loading) ...
        const groupid = process.env.GROUP_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const studentIdsInput = process.env.STUDENT_IDS;
        const groupIds = groupid?.split(",");

        let templateHeader = { show_header: true, margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 } };
        if (process.env.TEMPLATE_HEADER) {
            try {
                let fixedJson = process.env.TEMPLATE_HEADER.trim().replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');
                templateHeader = JSON.parse(fixedJson);
            } catch (e) { console.warn("⚠️ Header config parse error, using defaults."); }
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.mkdir(outputDir, { recursive: true });
        tempDir = path.join(outputDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });

        // ... (API Calls) ...
        const schoolDetailsRes = await fetch('https://demoschool.edusparsh.com/api/get_School_Detail', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ school_id: schoolId })
        });
        let schoolDetails = cleanData(await schoolDetailsRes.json());
        try { schoolDetails.signatures = JSON.parse(schoolDetails.config || '{}'); } catch (e) { }
        if (schoolDetails.logo) schoolDetails.logo = `https://schoolerp-bucket.blr1.cdn.digitaloceanspaces.com/supa-img/${schoolId}/${schoolDetails.logo}`;

        // Fetch Naming Convention
        let namingConvention = null;
        try {
            const configRes = await fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _school: schoolId, config_key: 'NamingConvention' })
            });
            if (configRes.ok) namingConvention = (await configRes.json())?.config_value;
        } catch (e) { }

        const marksRes = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _school: schoolId, batchId: [batchId], group: groupIds, currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID }, student_ids: studentIdsInput?.split(',') })
        });
        let students = (await marksRes.json()).students || [];
        if (!students.length) return;

        const configRes = await fetch('https://demoschool.edusparsh.com/api/marksheetdataodt', {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _school: schoolId, groupIds, batchId, studentIds: students.map(s => s.student_id), students })
        });
        const { transformedStudents } = await configRes.json();

        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.writeFile(templatePath, templateBuffer);

        const pdfPaths = [];

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);
            console.log(`\n--- 📝 Processing student: ${student.full_name} ---`);

            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, schoolDetails, tempDir);

            if (namingConvention) {
                transformedData = applyNamingConvention(transformedData, namingConvention);
            }

            // Generate ODT
            const dataForCarbone = { ...transformedData, school: schoolDetails, details: {} };
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${i}`;
            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);

            // Convert to PDF
            const finalPdfPath = await convertOdtToPdf(odtFilename, outputDir);

            // Apply Overlay if needed
            if (!templateHeader.show_header) {
                const overlaidPath = path.join(outputDir, `${fileSafeName}_final.pdf`);
                await addWhiteOverlay(finalPdfPath, overlaidPath, templateHeader.margins);
                pdfPaths.push(overlaidPath);
            } else {
                pdfPaths.push(finalPdfPath);
            }
        }

        // Merge and Upload
        if (pdfPaths.length > 0) {
            const mergedPath = path.join(outputDir, 'merged.pdf');
            const compressedPath = path.join(outputDir, 'compressed.pdf');
            await mergePdfs(pdfPaths, mergedPath);
            await compressPdf(mergedPath, compressedPath);

            const formData = new FormData();
            formData.append('photo', await fs.readFile(compressedPath), { filename: 'result.pdf', contentType: 'application/pdf' });
            formData.append('key', `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST', headers: formData.getHeaders(), body: formData
            });
            await updateJobHistory(jobId, schoolId, { file_path: `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`, status: true });
        }

        console.log("\n🎉 Generation complete.");
    } catch (error) {
        console.error('❌ FATAL ERROR:', error);
        if (jobId && schoolId) await updateJobHistory(jobId, schoolId, { status: false, notes: error.message });
    } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
}

GenerateOdtFile();