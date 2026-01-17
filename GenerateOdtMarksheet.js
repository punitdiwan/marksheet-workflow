const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');

// --- CUSTOM FORMATTER ---
carbone.formatters.showWithLabel = function (value, label) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    return label + ' ' + value;
};

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

// --- NAMING CONVENTION HELPER ---
function applyNamingConvention(data, convention) {
    if (!convention || typeof data !== 'object' || data === null) {
        if (typeof data === 'string') {
            switch (convention.toLowerCase()) {
                case 'uppercase': return data.toUpperCase();
                case 'lowercase': return data.toLowerCase();
                case 'capitalize': return data.replace(/\b\w/g, char => char.toUpperCase());
                default: return data;
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
            console.error(`⚠️ Could not update job_history: ${await jobUpdateRes.text()}`);
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
    // Ensure output directory exists and is absolute
    const absOutputDir = path.resolve(outputDir);
    const absOdtPath = path.resolve(odtPath);

    // Check if source exists before running command
    try {
        await fs.access(absOdtPath);
    } catch (e) {
        throw new Error(`ODT Source file missing before conversion: ${absOdtPath}`);
    }

    const command = `libreoffice --headless --convert-to pdf --outdir "${absOutputDir}" "${absOdtPath}"`;
    try {
        console.log(`🔄 Running conversion for: ${path.basename(odtPath)}`);
        const { stdout, stderr } = await execPromise(command);

        if (stderr && !stderr.toLowerCase().includes('warning')) {
            console.warn(`[LibreOffice STDERR]:`, stderr);
        }

        const expectedPdfPath = path.join(absOutputDir, path.basename(odtPath, '.odt') + '.pdf');

        // Verify PDF was actually created
        try {
            await fs.access(expectedPdfPath);
            return expectedPdfPath;
        } catch (e) {
            throw new Error(`LibreOffice command finished but PDF was not created at ${expectedPdfPath}`);
        }
    } catch (error) {
        console.error(`❌ LibreOffice command failed for ${path.basename(odtPath)}.`);
        if (error.stdout) console.error('--- STDOUT ---', error.stdout);
        if (error.stderr) console.error('--- STDERR ---', error.stderr);
        throw error;
    }
}

async function addWhiteOverlay(inputPdfPath, outputPdfPath, options = {}) {
    const { heightCm = 5, topMarginCm = 0, leftMarginCm = 0, rightMarginCm = 0 } = options;
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
            const rectWidth = pageWidth - leftMargin - rightMargin;

            if (rectWidth > 0) {
                page.drawRectangle({
                    x: leftMargin,
                    y: pageHeight - topMargin - overlayHeight,
                    width: rectWidth,
                    height: overlayHeight,
                    color: rgb(1, 1, 1),
                    borderWidth: 0,
                });
            }
        }

        const pdfBytes = await pdfDoc.save();
        await fs.writeFile(outputPdfPath, pdfBytes);
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
    await execPromise(command);
}

async function fetchImage(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        return await sharp(buffer).toFormat('png').toBuffer();
    } catch (err) {
        console.warn("⚠️ Could not fetch or convert photo:", url);
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
            else return false;
        }
    }
}

async function findImageFilename(contentXmlPath, picturesDir, frameName) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsedXml = await parseXml(contentXml, { explicitArray: false, mergeAttrs: true });

        function findFrames(node) {
            let frames = [];
            if (typeof node !== 'object' || node === null) return frames;
            if (node['draw:frame']) {
                const f = node['draw:frame'];
                frames.push(...(Array.isArray(f) ? f : [f]));
            }
            for (const key in node) {
                if (typeof node[key] === 'object') frames.push(...findFrames(node[key]));
            }
            return frames;
        }

        const textContent = parsedXml['office:document-content']?.['office:body']?.['office:text'] || {};
        const drawFrames = findFrames(textContent);

        for (const frame of drawFrames) {
            if (frame['draw:name'] === frameName && frame['draw:image']) {
                const href = frame['draw:image']['xlink:href'];
                if (href && href.startsWith('Pictures/') && /\.(png|jpg|jpeg)$/i.test(href)) {
                    return href.replace('Pictures/', '');
                }
            }
        }
        return null;
    } catch (err) {
        return null;
    }
}

// --- FIXED ODT ZIPPING FUNCTION ---
async function replaceImageInOdt(templatePath, student, schoolDetails, tempDir) {
    const studentDir = path.join(tempDir, `student_${student.student_id}`);
    await fs.mkdir(studentDir, { recursive: true });

    // Unzip ODT
    const unzipPromise = new Promise((resolve, reject) => {
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

    try {
        await unzipPromise;
    } catch (err) {
        console.error(`❌ Failed to unzip template:`, err);
        return templatePath;
    }

    // Image Replacement Logic
    const contentXmlPath = path.join(studentDir, 'content.xml');
    const picturesDir = path.join(studentDir, 'Pictures');
    await fs.mkdir(picturesDir, { recursive: true });

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

    let anyImageReplaced = false;
    for (const replacement of imageReplacements) {
        if (!replacement.url) continue;
        const targetFilename = await findImageFilename(contentXmlPath, picturesDir, replacement.frameName);
        if (!targetFilename) continue;

        const imageBuffer = await fetchImage(replacement.url);
        if (imageBuffer) {
            await fs.writeFile(path.join(picturesDir, targetFilename), imageBuffer);
            anyImageReplaced = true;
        }
    }

    if (anyImageReplaced) {
        try {
            await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`);
        } catch (e) { }
    }

    // --- CRITICAL FIX: RE-ZIP ODT CORRECTLY ---
    const safeName = student.full_name?.replace(/\s+/g, '_') || student.student_id;
    const newOdtPath = path.join(tempDir, `${safeName}.odt`);
    const zip = new yazl.ZipFile();

    // 1. Add mimetype file FIRST and UNCOMPRESSED
    const mimetypePath = path.join(studentDir, 'mimetype');
    try {
        await fs.access(mimetypePath);
        // Add mimetype stored (0 compression)
        zip.addFile(mimetypePath, 'mimetype', { compress: false });
    } catch (e) {
        console.warn("⚠️ mimetype file missing in ODT, file might be corrupt.");
    }

    // 2. Add remaining files
    const walkDir = async (dir, zipPath = '') => {
        const files = await fs.readdir(dir);
        for (const file of files) {
            // Skip mimetype as we added it already
            if (zipPath === '' && file === 'mimetype') continue;

            const fullPath = path.join(dir, file);
            const stats = await fs.stat(fullPath);
            const zipEntry = path.join(zipPath, file);

            if (stats.isDirectory()) {
                await walkDir(fullPath, zipEntry);
            } else {
                zip.addFile(fullPath, zipEntry);
            }
        }
    };

    try {
        await walkDir(studentDir);
        const writeStream = require('fs').createWriteStream(newOdtPath);
        zip.outputStream.pipe(writeStream);
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            zip.end();
        });

        // Wait briefly to ensure filesystem sync
        await new Promise(r => setTimeout(r, 200));

        return newOdtPath;
    } catch (err) {
        console.error(`❌ Failed to re-zip ODT:`, err);
        return templatePath;
    }
}

function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) return '';
    if (Array.isArray(data)) return data.map(item => cleanData(item));
    if (typeof data === 'object') {
        const obj = {};
        for (const key in data) {
            obj[key] = (data[key] === 'NaN') ? '' : cleanData(data[key]);
        }
        return obj;
    }
    return data;
}

// --- MAIN FUNCTION ---
async function GenerateOdtFile() {
    let outputDir = '';
    let tempDir = '';
    const jobId = process.env.JOB_ID;
    const schoolId = process.env.SCHOOL_ID;

    try {
        const groupid = process.env.GROUP_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");
        const studentIdsInput = process.env.STUDENT_IDS;

        let templateHeader = { show_header: true, margins: { heightCm: 5 } };
        if (process.env.TEMPLATE_HEADER) {
            try {
                // Sanitize input JSON
                let fixedJson = process.env.TEMPLATE_HEADER.trim().replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');
                templateHeader = JSON.parse(fixedJson);
            } catch (e) {
                console.warn("⚠️ Header parsing failed, using defaults.");
            }
        }

        if (!templateUrl || !schoolId || !batchId) throw new Error('❌ Missing env variables.');

        outputDir = path.join(process.cwd(), 'output');
        await fs.mkdir(outputDir, { recursive: true });
        tempDir = path.join(outputDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });

        const pdfPaths = [];

        // Fetch Data
        console.log("🏫 Fetching data...");
        const [schoolRes, configRes, namingRes, studentsRes] = await Promise.all([
            fetch('https://demoschool.edusparsh.com/api/get_School_Detail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ school_id: schoolId })
            }),
            fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ _school: schoolId, config_key: 'student_details_config' })
            }),
            fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ _school: schoolId, config_key: 'NamingConvention' })
            }),
            fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    _school: schoolId,
                    batchId: [batchId],
                    group: groupIds,
                    currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID },
                    student_ids: studentIdsInput ? studentIdsInput.split(',') : undefined
                })
            })
        ]);

        const schoolDetails = cleanData(await schoolRes.json());
        if (schoolDetails.logo) {
            schoolDetails.logo = `https://schoolerp-bucket.blr1.cdn.digitaloceanspaces.com/supa-img/${schoolId}/${schoolDetails.logo}`;
        }
        try { schoolDetails.signatures = JSON.parse(schoolDetails.config); } catch (e) { }

        const studentConfigData = await configRes.json();
        const studentDetailsConfig = studentConfigData?.config_value;

        const namingData = await namingRes.json();
        const namingConvention = namingData?.config_value;

        const studentsData = await studentsRes.json();
        let students = studentsData.students || studentsData.data || [];
        students = students.filter(s => s?.student_id);

        if (students.length === 0) {
            await updateJobHistory(jobId, schoolId, { status: true, notes: "No students found." });
            return;
        }

        // Get Transformed Data
        const apiRes = await fetch('https://demoschool.edusparsh.com/api/marksheetdataodt', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                _school: schoolId,
                groupIds,
                batchId,
                studentIds: students.map(s => s.student_id),
                students,
            }),
        });
        const { transformedStudents } = await apiRes.json();

        // Download Template
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.writeFile(templatePath, templateBuffer);

        // Process Students
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);
            console.log(`\n--- Processing ${student.full_name} (${i + 1}/${students.length}) ---`);

            // 1. Image Replacement (Zipping fixed)
            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, schoolDetails, tempDir);

            // 2. Prepare Data
            let details = {};
            for (let j = 1; j <= 25; j++) { details[`label${j}`] = ''; details[`value${j}`] = ''; }
            if (studentDetailsConfig) {
                try {
                    JSON.parse(studentDetailsConfig).forEach((item, idx) => {
                        details[`label${idx + 1}`] = item.label;
                        details[`value${idx + 1}`] = transformedData[item.key] || '';
                    });
                } catch (e) { }
            }

            if (namingConvention) {
                transformedData = applyNamingConvention(transformedData, namingConvention);
                details = applyNamingConvention(details, namingConvention);
            }

            // 3. Render Carbone
            const dataForCarbone = { ...transformedData, school: schoolDetails, details };
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;

            // Render directly from the modified ODT path which is now a VALID ODT
            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);

            // 4. Convert to PDF
            const finalPdfPath = await convertOdtToPdf(odtFilename, outputDir);

            // 5. Overlay
            if (!templateHeader.show_header) {
                await addWhiteOverlay(finalPdfPath, path.join(outputDir, `${fileSafeName}_modified.pdf`), {
                    heightCm: templateHeader.margins.heightCm || 5
                });
                pdfPaths.push(path.join(outputDir, `${fileSafeName}_modified.pdf`));
            } else {
                pdfPaths.push(finalPdfPath);
            }

            console.log(`✅ Completed ${student.full_name}`);
        }

        // Merge & Upload
        if (pdfPaths.length > 0) {
            const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
            const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

            await mergePdfs(pdfPaths, mergedPdfPath);
            await compressPdf(mergedPdfPath, compressedPdfPath);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.readFile(compressedPdfPath);
            const formData = new FormData();
            formData.append('photo', fileBuffer, { filename: 'merged.pdf', contentType: 'application/pdf' });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');

            await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log("🎉 Done!");
        } else {
            console.warn("⚠️ No PDFs generated.");
        }

    } catch (error) {
        console.error('❌ FATAL ERROR:', error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: error.message.substring(0, 500) });
        }
        process.exit(1);
    } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
}

GenerateOdtFile();