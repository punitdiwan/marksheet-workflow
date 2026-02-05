const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');

// --- NEW: ADD CUSTOM FORMATTER ---
carbone.formatters.showWithLabel = function (value, label) {
    // If value is empty, return nothing (an empty string).
    if (value === null || value === undefined || value === '') {
        return '';
    }
    // If value exists, return the label followed by the value.
    return label + ' ' + value;
};
// --- END OF NEW FORMATTER ---

// --- NEW: CO-SCHOLASTIC GRADE FORMATTER ---
carbone.formatters.coGrade = function (coScholastic, subjectName, groupCode) {
    // 1. Debug Log: Check if function is called
    console.log(`DEBUG: coGrade called for Subject: "${subjectName}", Group: "${groupCode}"`);

    if (!Array.isArray(coScholastic)) {
        console.log("DEBUG: coScholastic is not an array or is empty.");
        return "";
    }

    const targetName = String(subjectName).trim().toLowerCase();

    const subject = coScholastic.find(s =>
        String(s.name || "")
            .trim()
            .toLowerCase() === targetName
    );

    if (!subject) {
        console.log(`DEBUG: Subject "${targetName}" not found in list.`);
        return "";
    }

    const result = subject.groups?.[groupCode]?.grade ?? "";
    console.log(`DEBUG: Found grade: "${result}"`);
    return result;
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

// --- NEW: NAMING CONVENTION HELPER FUNCTION ---
/**
 * Applies a naming convention to all string values within a data structure.
 * @param {*} data The data to transform (object, array, or primitive).
 * @param {string} convention The convention to apply ('uppercase', 'lowercase', 'capitalize').
 * @returns {*} The transformed data.
 */
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
// --- END OF NEW HELPER FUNCTION ---

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
            const errorData = await jobUpdateRes.text();
            console.error(`⚠️ Could not update job_history: ${errorData || jobUpdateRes.statusText}`);
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

        if (stderr) {
            console.warn(`[LibreOffice STDERR for ${path.basename(odtPath)}]:`, stderr);
        }

        return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
    } catch (error) {
        console.error(`❌ LibreOffice command failed for ${path.basename(odtPath)}.`);
        console.error('--- STDOUT ---');
        console.error(error.stdout);
        console.error('--- STDERR ---');
        console.error(error.stderr);
        throw new Error(`LibreOffice conversion failed. See logs above.`);
    }
}

/**
 * Adds a white overlay to the top of a PDF file with configurable margins.
 * @param {string} inputPdfPath - The path to the input PDF.
 * @param {string} outputPdfPath - The path where the modified PDF will be saved.
 * @param {object} [options={}] - Configuration for the overlay.
 * @param {number} [options.heightCm=5] - The height of the overlay itself in centimeters.
 * @param {number} [options.topMarginCm=0] - The space from the absolute top of the page before the overlay begins, in centimeters.
 * @param {number} [options.leftMarginCm=0] - The margin from the left edge of the page in centimeters.
 * @param {number} [options.rightMarginCm=0] - The margin from the right edge of the page in centimeters.
 */
async function addWhiteOverlay(inputPdfPath, outputPdfPath, options = {}) {
    const {
        heightCm = 5,
        topMarginCm = 0,
        leftMarginCm = 0,
        rightMarginCm = 0,
    } = options;

    console.log(`🎨 Adding white overlay to ${path.basename(inputPdfPath)} with options:`, { heightCm, topMarginCm, leftMarginCm, rightMarginCm });

    try {
        const POINTS_PER_CM = 28.3465; // Standard conversion factor for PDF points (72 DPI)

        // Convert all dimensions from cm to points
        const overlayHeight = heightCm * POINTS_PER_CM;
        const topMargin = topMarginCm * POINTS_PER_CM;
        const leftMargin = leftMarginCm * POINTS_PER_CM;
        const rightMargin = rightMarginCm * POINTS_PER_CM;

        const existingPdfBytes = await fs.readFile(inputPdfPath);
        const pdfDoc = await PDFDocument.load(existingPdfBytes);
        const pages = pdfDoc.getPages();

        for (const page of pages) {
            const { width: pageWidth, height: pageHeight } = page.getSize();

            // Calculate the dimensions and position of the rectangle
            const rectX = leftMargin;
            const rectY = pageHeight - topMargin - overlayHeight;
            const rectWidth = pageWidth - leftMargin - rightMargin;
            const rectHeight = overlayHeight;

            // Ensure width is not negative if margins are too large
            if (rectWidth < 0) {
                console.warn(`⚠️  Margins (${leftMarginCm}cm + ${rightMarginCm}cm) are wider than the page. Overlay will not be drawn for this page.`);
                continue; // Skip drawing on this page
            }

            page.drawRectangle({
                x: rectX,
                y: rectY,
                width: rectWidth,
                height: rectHeight,
                color: rgb(1, 1, 1), // White
                borderWidth: 0,
            });
        }

        const pdfBytes = await pdfDoc.save();
        await fs.writeFile(outputPdfPath, pdfBytes);
        console.log(`✅ Overlay added successfully. Saved to ${outputPdfPath}`);
    } catch (error) {
        console.error(`❌ Failed to add white overlay to ${path.basename(inputPdfPath)}:`, error);
        // Fallback: copy the original file to the output path so the process can continue
        await fs.copyFile(inputPdfPath, outputPdfPath);
        console.warn(`⚠️ Copied original PDF to output path as a fallback.`);
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
        console.log(`🗜️  Compressing PDF: ${path.basename(inputPath)}`);
        await execPromise(command);
        console.log(`✅ Compression successful. Output: ${outputPath}`);
    } catch (error) {
        console.error(`❌ Ghostscript compression failed for ${path.basename(inputPath)}.`);
        console.error('--- STDOUT ---');
        console.error(error.stdout);
        console.error('--- STDERR ---');
        console.error(error.stderr);
        throw new Error(`Ghostscript compression failed. See logs above.`);
    }
}

async function fetchImage(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        // Convert to PNG to ensure transparency
        return await sharp(buffer).toFormat('png').toBuffer();
    } catch (err) {
        console.warn("⚠️ Could not fetch or convert photo:", url, err.message);
        return null;
    }
}

async function waitForFile(filePath, retries = 5, delay = 100) {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.access(filePath);
            return true;
        } catch (err) {
            if (err.code === 'ENOENT' && i < retries - 1) {
                console.log(`⌛ Waiting for ${filePath} to be available (${i + 1}/${retries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw err;
            }
        }
    }
    return false;
}

async function findImageFilename(contentXmlPath, picturesDir, frameName) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsedXml = await parseXml(contentXml, {
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: true,
            normalizeTags: false,
            explicitChildren: true,
            preserveChildrenOrder: true
        });

        console.log(`DEBUG: Starting search for draw:image with draw:name="${frameName}"`);

        function findFrames(node) {
            let frames = [];
            if (typeof node !== 'object' || node === null) return frames;

            if (node['draw:frame']) {
                const frame = node['draw:frame'];
                if (Array.isArray(frame)) {
                    frames.push(...frame);
                } else {
                    frames.push(frame);
                }
            }

            for (const key in node) {
                if (Object.prototype.hasOwnProperty.call(node, key)) {
                    if (Array.isArray(node[key])) {
                        node[key].forEach(child => {
                            frames.push(...findFrames(child));
                        });
                    } else if (typeof node[key] === 'object') {
                        frames.push(...findFrames(node[key]));
                    }
                }
            }
            return frames;
        }

        const textContent = parsedXml['office:document-content']?.['office:body']?.['office:text'] || {};
        const drawFrames = findFrames(textContent);
        // console.log(`DEBUG: Found ${drawFrames.length} draw:frame elements`);

        for (const frame of drawFrames) {
            if (frame['draw:name'] === frameName && frame['draw:image']) {
                const image = frame['draw:image'];
                const href = image['xlink:href'];
                // console.log(`DEBUG: Found draw:image with draw:name="${frameName}", href=${href}`);
                if (href && href.startsWith('Pictures/') && /\.(png|jpg|jpeg)$/i.test(href)) {
                    const filename = href.replace('Pictures/', '');
                    const filePath = path.join(picturesDir, filename);
                    try {
                        await fs.access(filePath);
                        // console.log(`DEBUG: Confirmed image file exists: ${filePath}`);
                        return filename;
                    } catch (err) {
                        console.warn(`⚠️ Image ${filename} referenced in content.xml but not found in Pictures directory:`, err.message);
                    }
                }
            }
        }

        // console.warn(`⚠️ No image with draw:name="${frameName}" found in content.xml.`);
        return null;
    } catch (err) {
        console.error(`❌ Failed to parse content.xml or read Pictures directory for ${frameName}:`, err);
        return null;
    }
}

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
        console.log(`✅ Unzipped template for ${student.full_name} to ${studentDir}`);
    } catch (err) {
        console.error(`❌ Failed to unzip template for ${student.full_name}:`, err);
        return templatePath;
    }

    const contentXmlPath = path.join(studentDir, 'content.xml');
    const stylesXmlPath = path.join(studentDir, 'styles.xml');
    const picturesDir = path.join(studentDir, 'Pictures');
    await fs.mkdir(picturesDir, { recursive: true });

    // 1. Read content.xml and styles.xml
    let contentXml = await fs.readFile(contentXmlPath, 'utf-8');
    let stylesXml = null;
    try {
        stylesXml = await fs.readFile(stylesXmlPath, 'utf-8');
    } catch (e) {
        // styles.xml might not exist
    }

    // --- FIX START: NUCLEAR OPTION FOR TEXT SPACING ---
    const fixSpacingIssues = (xml, filename) => {
        if (!xml) return xml;
        let newXml = xml;
        let changed = false;

        // 1. Fix Alignment (Handle both " and ' quotes)
        if (/fo:text-align\s*=\s*["']justify["']/i.test(newXml)) {
            newXml = newXml.replace(/fo:text-align\s*=\s*["']justify["']/gi, 'fo:text-align="left"');
            changed = true;
        }

        // 2. Fix Last Line Alignment (Major culprit for labels)
        if (/fo:text-align-last\s*=\s*["']justify["']/i.test(newXml)) {
            newXml = newXml.replace(/fo:text-align-last\s*=\s*["']justify["']/gi, 'fo:text-align-last="left"');
            changed = true;
        }

        // 3. Fix Letter Spacing (Reset wide spacing to normal)
        // This finds `fo:letter-spacing="..."` and forces it to "normal"
        if (/fo:letter-spacing\s*=\s*["'][^"']*["']/i.test(newXml)) {
            newXml = newXml.replace(/fo:letter-spacing\s*=\s*["'][^"']*["']/gi, 'fo:letter-spacing="normal"');
            changed = true;
        }

        // 4. Fix Text Scale (Reset horizontal stretching)
        if (/style:text-scale\s*=\s*["'][^"']*["']/i.test(newXml)) {
            newXml = newXml.replace(/style:text-scale\s*=\s*["'][^"']*["']/gi, 'style:text-scale="100%"');
            changed = true;
        }

        if (changed) console.log(`🔧 Fixed text spacing/alignment issues in ${filename}`);
        return newXml;
    };

    contentXml = fixSpacingIssues(contentXml, 'content.xml');
    if (stylesXml) {
        const fixedStyles = fixSpacingIssues(stylesXml, 'styles.xml');
        if (fixedStyles !== stylesXml) {
            await fs.writeFile(stylesXmlPath, fixedStyles);
        }
    }
    // --- FIX END ---

    // Define images to replace
    const imageReplacements = [
        { frameName: 'Logo', url: schoolDetails.logo, description: 'School Logo' },
        { frameName: 'studentImage', url: student.photo, description: 'Student Photo' }
    ];

    if (schoolDetails.signatures && typeof schoolDetails.signatures === 'object') {
        for (const key in schoolDetails.signatures) {
            if (Object.prototype.hasOwnProperty.call(schoolDetails.signatures, key)) {
                const signatureInfo = schoolDetails.signatures[key];
                if (signatureInfo?.url) {
                    imageReplacements.push({
                        frameName: key,
                        url: signatureInfo.url,
                        description: signatureInfo.name || `Signature ${key}`
                    });
                }
            }
        }
    }

    let anyImageReplaced = false;
    let newManifestEntries = [];

    for (const replacement of imageReplacements) {
        const { frameName, url, description } = replacement;
        if (!url || !String(url).startsWith("http")) continue;

        const frameRegex = new RegExp(`(<draw:frame[^>]*draw:name="${frameName}"[\\s\\S]*?<draw:image[^>]*xlink:href=")([^"]+)(")`, 'i');

        if (frameRegex.test(contentXml)) {
            console.log(`➡️  Processing image for frame "${frameName}"...`);
            const imageBuffer = await fetchImage(url);

            if (imageBuffer) {
                const newFilename = `${frameName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
                const imagePath = path.join(picturesDir, newFilename);
                try {
                    await fs.writeFile(imagePath, imageBuffer);
                    contentXml = contentXml.replace(frameRegex, `$1Pictures/${newFilename}$3`);
                    newManifestEntries.push(`<manifest:file-entry manifest:full-path="Pictures/${newFilename}" manifest:media-type="image/png"/>`);
                    console.log(`✅ Replaced ${description} (${frameName}) with: ${newFilename}`);
                    anyImageReplaced = true;
                } catch (writeError) {
                    console.error(`❌ Failed to write new image for ${description}:`, writeError);
                }
            }
        }
    }

    // Always write content.xml back to apply the text spacing fix
    try {
        await fs.writeFile(contentXmlPath, contentXml);

        if (anyImageReplaced && newManifestEntries.length > 0) {
            const manifestPath = path.join(studentDir, 'META-INF', 'manifest.xml');
            let manifestXml = await fs.readFile(manifestPath, 'utf-8').catch(() => '');
            if (manifestXml && manifestXml.includes('</manifest:manifest>')) {
                manifestXml = manifestXml.replace('</manifest:manifest>', `${newManifestEntries.join('\n')}\n</manifest:manifest>`);
                await fs.writeFile(manifestPath, manifestXml);
            }
        }
        await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`).catch(() => { });
    } catch (err) {
        console.warn(`⚠️ Error saving ODT XML files: ${err.message}`);
    }

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

        if (await waitForFile(newOdtPath)) return newOdtPath;
        throw new Error(`File not created.`);
    } catch (err) {
        console.error(`❌ Failed to re-zip ODT for ${student.full_name}:`, err);
        return templatePath;
    }
}

function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) {
        return '';
    }
    if (Array.isArray(data)) {
        return data.map(item => cleanData(item));
    }
    if (typeof data === 'object') {
        const cleanedObject = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                if (data[key] === 'NaN') {
                    cleanedObject[key] = '';
                } else {
                    cleanedObject[key] = cleanData(data[key]);
                }
            }
        }
        return cleanedObject;
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
        console.log("🚀 Starting dynamic marksheet generation with Carbone...");

        const groupid = process.env.GROUP_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");
        const studentIdsInput = process.env.STUDENT_IDS;
        // --- IMPROVED: Safely parse TEMPLATE_HEADER with better error handling ---
        let templateHeader = {
            show_header: true,
            margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 }
        };

        if (process.env.TEMPLATE_HEADER) {
            console.log(`🔍 Raw TEMPLATE_HEADER value: "${process.env.TEMPLATE_HEADER}"`);

            let fixedJson = process.env.TEMPLATE_HEADER.trim().replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');

            console.log(`🔧 Fixed TEMPLATE_HEADER attempt: "${fixedJson}"`);

            try {
                templateHeader = JSON.parse(fixedJson);
                console.log(`✅ Successfully parsed TEMPLATE_HEADER:`, templateHeader);

                // Ensure we have valid structure
                if (typeof templateHeader.show_header !== 'boolean') {
                    console.warn(`⚠️ Invalid show_header value. Defaulting to true.`);
                    templateHeader.show_header = true;
                }

                if (!templateHeader.margins || typeof templateHeader.margins !== 'object') {
                    console.warn(`⚠️ Invalid margins structure. Using defaults.`);
                    templateHeader.margins = { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 };
                }

            } catch (parseError) {
                console.error(`❌ Failed to parse TEMPLATE_HEADER:`, parseError.message);

                templateHeader = {
                    show_header: true,
                    margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 }
                };
            }
        }

        const applyOverlay = !templateHeader.show_header;
        const overlayOptions = {
            heightCm: templateHeader.margins.heightCm || 5,
            topMarginCm: templateHeader.margins.topMarginCm || 0,
            leftMarginCm: templateHeader.margins.leftMarginCm || 0,
            rightMarginCm: templateHeader.margins.rightMarginCm || 0
        };

        console.log(`🎯 Template header config: show_header=${templateHeader.show_header}, applyOverlay=${applyOverlay}`);

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables.');
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.mkdir(outputDir, { recursive: true });
        tempDir = path.join(outputDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });
        const pdfPaths = [];

        // Fetch School Details
        console.log("🏫 Fetching school details...");
        const schoolDetailsPayload = { school_id: schoolId };
        const schoolDetailsResponse = await fetch('https://demoschool.edusparsh.com/api/get_School_Detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(schoolDetailsPayload),
        });
        if (!schoolDetailsResponse.ok) throw new Error(`Failed to fetch school details: ${await schoolDetailsResponse.text()}`);
        let schoolDetails = cleanData(await schoolDetailsResponse.json());

        // ✨ NEW: Parse signature config from schoolDetails
        let signatureConfig = {};
        if (schoolDetails.config && typeof schoolDetails.config === 'string') {
            try {
                signatureConfig = JSON.parse(schoolDetails.config);
                console.log("✅ Parsed signature config from school details.");
            } catch (e) {
                console.warn("⚠️ Could not parse schoolDetails.config JSON for signatures:", e.message);
            }
        }
        schoolDetails.signatures = signatureConfig; // Attach for easy access

        console.log("✅ School details fetched successfully.");

        console.log("⚙️ Fetching student details configuration...");
        let studentDetailsConfigFromApi = null;
        try {
            const configPayload = {
                _school: schoolId,
                config_key: 'student_details_config'
            };

            const configResponse = await fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });

            if (configResponse.ok) {
                const configData = await configResponse.json();
                if (configData && configData.config_value) {
                    studentDetailsConfigFromApi = configData.config_value;
                    console.log("✅ Successfully fetched student details configuration from API.");
                } else {
                    console.warn("⚠️ Config fetched, but 'config_value' is missing.");
                }
            } else {
                console.warn(`⚠️ API failed to fetch remote config (${configResponse.statusText}).`);
            }
        } catch (configError) {
            console.warn(`⚠️ Error fetching remote config: ${configError.message}.`);
        }

        // --- NEW: FETCH NAMING CONVENTION CONFIG ---
        console.log("⚙️ Fetching naming convention configuration...");
        let namingConvention = null;
        try {
            const configPayload = {
                _school: schoolId,
                config_key: 'NamingConvention'
            };
            const configResponse = await fetch('https://demoschool.edusparsh.com/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });
            if (configResponse.ok) {
                const configData = await configResponse.json();
                if (configData && configData.config_value) {
                    namingConvention = configData.config_value;
                    console.log(`✅ Successfully fetched NamingConvention: "${namingConvention}"`);
                } else {
                    console.warn("⚠️ NamingConvention config fetched, but 'config_value' is missing.");
                }
            } else {
                console.warn(`⚠️ API failed to fetch NamingConvention config (${configResponse.statusText}).`);
            }
        } catch (configError) {
            console.warn(`⚠️ Error fetching NamingConvention config: ${configError.message}.`);
        }
        // --- END OF NEW FETCH ---

        if (schoolDetails.logo && typeof schoolDetails.logo === 'string') {
            schoolDetails.logo = `https://schoolerp-bucket.blr1.cdn.digitaloceanspaces.com/supa-img/${schoolId}/${schoolDetails.logo}`;
            console.log(`✅ Transformed school logo to: ${schoolDetails.logo}`);
        } else {
            console.warn(`⚠️ School logo not found or invalid.`);
        }

        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID }
        };

        // Determine which API to call. If we have specific students (Previous Year), use studentWiseMarks.
        let fetchUrl = 'https://demoschool.edusparsh.com/api/cce_examv1/getMarks';

        if (studentIdsInput) {
            const sIds = studentIdsInput.split(',');
            marksPayload.student_ids = sIds;
            marksPayload.student_id = sIds; // Add this key as studentWiseMarks often expects 'student_id'
            fetchUrl = 'https://demoschool.edusparsh.com/api/cce_examv1/studentWiseMarks';
        }

        console.log("📥 Fetching student data...");
        console.log(fetchUrl);

        const studentResponse = await fetch(fetchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(marksPayload),
        });

        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${await studentResponse.text()}`);
        const studentResponseJson = await studentResponse.json();
        let students = studentResponseJson.students || studentResponseJson.data || [];

        if (studentIdsInput) {
            const requestedStudentIds = new Set(studentIdsInput.split(','));
            students = students.filter(student => student && student.student_id && requestedStudentIds.has(student.student_id));
        }

        students = students.filter(s => s && s.student_id);

        if (students.length === 0) {
            console.warn("⚠️ No valid students found matching criteria. Exiting.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found." });
            return;
        }
        students = students.map(s => ({ ...s, _uid: s.student_id }));
        console.log(`✅ Found and will process ${students.length} student(s).`);

        console.log("📡 Fetching marksheet config + transformed data...");
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
        if (!apiRes.ok) throw new Error(`Config API failed: ${await apiRes.text()}`);
        const { transformedStudents } = await apiRes.json();
        if (!transformedStudents) throw new Error(`Config API failed: missing transformedStudents.`);
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);

            Object.keys(transformedData).forEach(key => {
                if (key.includes('&')) {
                    const safeKey = key.replace(/&/g, '_');
                    transformedData[safeKey] = transformedData[key];
                }
            });

            console.log(`\n--- 📝 Processing student: ${student.full_name} (${i + 1}/${students.length}) ---`);

            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, schoolDetails, tempDir);

            const dynamicDetailsConfig = studentDetailsConfigFromApi;
            let details = {};
            for (let j = 1; j <= 25; j++) { details[`label${j}`] = ''; details[`value${j}`] = ''; }

            if (dynamicDetailsConfig && typeof dynamicDetailsConfig === 'string') {
                try {
                    const config = JSON.parse(dynamicDetailsConfig);
                    if (Array.isArray(config)) {
                        config.forEach((item, index) => {
                            const slotNumber = index + 1;
                            if (item.label && item.key) {
                                details[`label${slotNumber}`] = item.label;
                                details[`value${slotNumber}`] = transformedData[item.key] || '';
                            }
                        });
                    } else {
                        console.warn('⚠️ Parsed dynamic config is not an array.');
                    }
                } catch (e) {
                    console.warn(`⚠️ Could not parse dynamic details config: ${e.message}`);
                }
            }

            if (namingConvention) {
                console.log(`Applying "${namingConvention}" naming convention to student data...`);
                transformedData = applyNamingConvention(transformedData, namingConvention);
                details = applyNamingConvention(details, namingConvention);
            }

            const dataForCarbone = { ...transformedData, school: schoolDetails, details: details };


            if (i === 0) {
                console.log(`\n--- DEBUG: FIRST STUDENT PAYLOAD ---`);
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`------------------------------------\n`);
            }

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);

            const originalPdfPath = await convertOdtToPdf(odtFilename, outputDir);
            let finalPdfPath = originalPdfPath;

            if (applyOverlay) {
                const modifiedPdfPath = path.join(outputDir, `${fileSafeName}_modified.pdf`);
                await addWhiteOverlay(originalPdfPath, modifiedPdfPath, overlayOptions);
                finalPdfPath = modifiedPdfPath;
            } else {
                console.log(`📜 Skipping white overlay for ${student.full_name}.`);
            }

            if (!require('fs').existsSync(finalPdfPath)) {
                console.error(`--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                throw new Error(`PDF generation failed for "${student.full_name}". File not found: ${finalPdfPath}.`);
            }
            console.log(`✅ Successfully created PDF for ${student.full_name}`);
            pdfPaths.push(finalPdfPath);
        }

        if (pdfPaths.length > 0) {
            const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
            const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

            console.log('🔗 Merging all generated PDFs...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created: ${mergedPdfPath}`);

            await compressPdf(mergedPdfPath, compressedPdfPath);
            const originalSize = (await fs.stat(mergedPdfPath)).size / (1024 * 1024);
            const compressedSize = (await fs.stat(compressedPdfPath)).size / (1024 * 1024);
            console.log(`📊 Compression: Original: ${originalSize.toFixed(2)} MB, Compressed: ${compressedSize.toFixed(2)} MB`);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.readFile(compressedPdfPath);
            const formData = new FormData();
            formData.append('photo', fileBuffer, { filename: 'merged_output.pdf', contentType: 'application/pdf' });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`📤 Uploading compressed PDF...`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) throw new Error(`File upload failed: ${await uploadRes.text()}`);
            console.log("✅ File uploaded. Updating job history...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log('✅ Job history updated.');
        } else {
            console.log('⚠️ No PDFs were generated to merge.');
        }

        console.log("\n🎉 Marksheets generated and uploaded successfully.");
    } catch (error) {
        console.error('❌ FATAL ERROR:', error.message || error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        throw error;
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
                console.warn(`⚠️ Failed to clean up temp directory: ${err.message}`);
            });
        }
    }
}

// --- EXECUTION ---
GenerateOdtFile();