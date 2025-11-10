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
        console.log(`DEBUG: Found ${drawFrames.length} draw:frame elements`);

        drawFrames.forEach((frame, index) => {
            const name = frame['draw:name'] || 'undefined';
            const image = frame['draw:image'];
            const href = image?.['xlink:href'] || 'undefined';
            console.log(`DEBUG: Frame ${index + 1} - draw:name="${name}", xlink:href="${href}"`);
        });

        for (const frame of drawFrames) {
            if (frame['draw:name'] === frameName && frame['draw:image']) {
                const image = frame['draw:image'];
                const href = image['xlink:href'];
                console.log(`DEBUG: Found draw:image with draw:name="${frameName}", href=${href}`);
                if (href && href.startsWith('Pictures/') && /\.(png|jpg|jpeg)$/i.test(href)) {
                    const filename = href.replace('Pictures/', '');
                    const filePath = path.join(picturesDir, filename);
                    try {
                        await fs.access(filePath);
                        console.log(`DEBUG: Confirmed image file exists: ${filePath}`);
                        return filename;
                    } catch (err) {
                        console.warn(`⚠️ Image ${filename} referenced in content.xml but not found in Pictures directory:`, err.message);
                    }
                }
            }
        }

        console.warn(`⚠️ No image with draw:name="${frameName}" found in content.xml.`);
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
    const picturesDir = path.join(studentDir, 'Pictures');
    let pictureFiles = [];

    try {
        pictureFiles = await fs.readdir(picturesDir);
        console.log(`DEBUG: Pictures directory contents: ${pictureFiles.join(', ')}`);
    } catch (err) {
        console.warn(`⚠️ Pictures directory not found or empty:`, err.message);
        pictureFiles = [];
    }

    if (pictureFiles.length === 1) {
        if (!schoolDetails.logo || !schoolDetails.logo.startsWith("http")) {
            console.warn(`⚠️ No valid school logo URL in schoolDetails: ${schoolDetails.logo || 'undefined'}. Using original template.`);
            return templatePath;
        }

        const schoolLogoBuffer = await fetchImage(schoolDetails.logo);
        if (!schoolLogoBuffer) {
            console.warn(`⚠️ Failed to fetch school logo from ${schoolDetails.logo}. Using original template.`);
            return templatePath;
        }

        const schoolLogoFilename = pictureFiles[0];
        const schoolLogoPath = path.join(picturesDir, schoolLogoFilename);
        await fs.writeFile(schoolLogoPath, schoolLogoBuffer);
        console.log(`✅ Replaced school logo at ${schoolLogoPath} (single file case)`);

        // Format content.xml with xmllint
        try {
            await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`);
            console.log(`✅ Formatted content.xml for ${student.full_name}`);
        } catch (err) {
            console.warn(`⚠️ xmllint formatting failed: ${err.message}. Using unformatted content.xml.`);
        }
    } else if (pictureFiles.length === 2) {
        let studentImageFilename = null;
        if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
            const studentImageBuffer = await fetchImage(student.photo);
            if (studentImageBuffer) {
                studentImageFilename = await findImageFilename(contentXmlPath, picturesDir, 'studentImage');
                if (studentImageFilename) {
                    const studentImagePath = path.join(picturesDir, studentImageFilename);
                    await fs.writeFile(studentImagePath, studentImageBuffer);
                    console.log(`✅ Wrote student image to ${studentImagePath}`);

                    let contentXml = await fs.readFile(contentXmlPath, 'utf-8');
                    contentXml = contentXml.replace(
                        new RegExp(`Pictures/[^"]+\\.(png|jpg|jpeg)(?="[^>]*draw:name="studentImage")`, 'i'),
                        `Pictures/${studentImageFilename}`
                    );
                    await fs.writeFile(contentXmlPath, contentXml);
                    console.log(`✅ Updated content.xml for student image for ${student.full_name}`);
                }
            }
        }

        let schoolLogoFilename = null;
        if (schoolDetails.logo && schoolDetails.logo.startsWith("http")) {
            const schoolLogoBuffer = await fetchImage(schoolDetails.logo);
            if (schoolLogoBuffer) {
                schoolLogoFilename = await findImageFilename(contentXmlPath, picturesDir, 'Logo');
                if (schoolLogoFilename) {
                    const schoolLogoPath = path.join(picturesDir, schoolLogoFilename);
                    await fs.writeFile(schoolLogoPath, schoolLogoBuffer);
                    console.log(`✅ Wrote school logo to ${schoolLogoPath}`);

                    let contentXml = await fs.readFile(contentXmlPath, 'utf-8');
                    contentXml = contentXml.replace(
                        new RegExp(`Pictures/[^"]+\\.(png|jpg|jpeg)(?="[^>]*draw:name="Logo")`, 'i'),
                        `Pictures/${schoolLogoFilename}`
                    );
                    await fs.writeFile(contentXmlPath, contentXml);
                    console.log(`✅ Updated content.xml for school logo for ${student.full_name}`);
                }
            }
        }

        // Format content.xml with xmllint
        try {
            await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`);
            console.log(`✅ Formatted content.xml for ${student.full_name}`);
        } catch (err) {
            console.warn(`⚠️ xmllint formatting failed: ${err.message}. Using unformatted content.xml.`);
        }
    } else {
        console.warn(`⚠️ Unexpected number of files in Pictures directory (${pictureFiles.length}). Using original template.`);
        return templatePath;
    }

    // Re-zip to create new ODT
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
        console.log(`✅ Zipped new ODT for ${student.full_name} at ${newOdtPath}`);

        const fileExists = await waitForFile(newOdtPath);
        if (!fileExists) {
            throw new Error(`File ${newOdtPath} was not created or accessible after zipping`);
        }
        return newOdtPath;
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

            // Try to fix common JSON formatting issues
            let fixedJson = process.env.TEMPLATE_HEADER.trim();

            // Add quotes around unquoted property names (basic fix)
            fixedJson = fixedJson.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*):/g, '$1"$2":');

            console.log(`🔧 Fixed TEMPLATE_HEADER attempt: "${fixedJson}"`);

            try {
                templateHeader = JSON.parse(fixedJson);
                console.log(`✅ Successfully parsed TEMPLATE_HEADER:`, templateHeader);

                // Ensure we have valid structure
                if (typeof templateHeader.show_header !== 'boolean') {
                    console.warn(`⚠️ Invalid show_header value: ${templateHeader.show_header}. Defaulting to true.`);
                    templateHeader.show_header = true;
                }

                if (!templateHeader.margins || typeof templateHeader.margins !== 'object') {
                    console.warn(`⚠️ Invalid margins structure. Using defaults.`);
                    templateHeader.margins = { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 };
                }

            } catch (parseError) {
                console.error(`❌ Failed to parse TEMPLATE_HEADER:`, parseError.message);
                // Use default values
                templateHeader = {
                    show_header: true,
                    margins: { heightCm: 5, topMarginCm: 0, leftMarginCm: 0, rightMarginCm: 0 }
                };
            }
        }

        // --- EXPLICIT LOGIC: Apply white overlay when show_header is false ---
        const applyOverlay = !templateHeader.show_header; // More explicit: invert the boolean
        const overlayOptions = {
            heightCm: templateHeader.margins.heightCm || 5,
            topMarginCm: templateHeader.margins.topMarginCm || 0,
            leftMarginCm: templateHeader.margins.leftMarginCm || 0,
            rightMarginCm: templateHeader.margins.rightMarginCm || 0
        };

        console.log(`🎯 Template header configuration:`);
        console.log(`   - show_header: ${templateHeader.show_header}`);
        console.log(`   - applyOverlay: ${applyOverlay}`);
        console.log(`   - overlay options:`, overlayOptions);

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables from GitHub Actions inputs.');
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
        if (!schoolDetailsResponse.ok) {
            throw new Error(`Failed to fetch school details: ${await schoolDetailsResponse.text()}`);
        }
        let schoolDetails = cleanData(await schoolDetailsResponse.json());
        console.log("✅ School details fetched successfully.",schoolDetails);

        // ✨ NEW: Fetch Student Details Configuration from the database
        console.log("⚙️ Fetching student details configuration...");
        let studentDetailsConfigFromApi = null;
        try {
            const configPayload = {
                _school: schoolId,
                config_key: 'student_details_config'
            };
            // Assuming an endpoint `/api/getConfiguration` exists to fetch from the `configurations` table
            const configResponse = await fetch('https://demoschool-git-mkoct28tempheader-punit-diwans-projects.vercel.app/api/getConfiguration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });

            if (configResponse.ok) {
                const configData = await configResponse.json();
                // Expecting the API to return the config value, e.g., { config_value: '[...]' }
                if (configData && configData.config_value) {
                    studentDetailsConfigFromApi = configData.config_value;
                    console.log("✅ Successfully fetched student details configuration from API.");
                } else {
                    console.warn("⚠️ Configuration fetched, but 'config_value' is missing from the response.");
                }
            } else {
                console.warn(`⚠️ API failed to fetch remote configuration (${configResponse.statusText}). Will fall back to environment variable if available.`);
            }
        } catch (configError) {
            console.warn(`⚠️ Error during API call for remote configuration: ${configError.message}. Will fall back to environment variable if available.`);
        }


        // Transform logo field to full URL
        if (schoolDetails.logo && typeof schoolDetails.logo === 'string') {
            schoolDetails.logo = `https://schoolerp-bucket.blr1.cdn.digitaloceanspaces.com/supa-img/${schoolId}/${schoolDetails.logo}`;
            console.log(`✅ Transformed school logo to: ${schoolDetails.logo}`);
        } else {
            console.warn(`⚠️ School logo not found or invalid in schoolDetails. Using original value: ${schoolDetails.logo || 'undefined'}`);
        }

        // STEP 1: Fetch student marks
        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID }
        };
        if (studentIdsInput) {
            console.log(`Filtering for specific students: ${studentIdsInput}`);
            marksPayload.student_ids = studentIdsInput.split(',');
        }

        console.log("📥 Fetching student data with payload:", JSON.stringify(marksPayload));
        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(marksPayload),
        });

        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${await studentResponse.text()}`);

        const studentResponseJson = await studentResponse.json();
        let students = studentResponseJson.students || studentResponseJson.data || [];

        if (studentIdsInput) {
            const requestedStudentIds = new Set(studentIdsInput.split(','));
            console.log(`API returned ${students.length} students. Now filtering for the ${requestedStudentIds.size} requested student(s).`);
            students = students.filter(student => student && student.student_id && requestedStudentIds.has(student.student_id));
        }

        students = students.filter(s => s && typeof s === 'object');
        students = students.filter(s => s.student_id);

        if (students.length === 0) {
            console.warn("⚠️ No valid students found matching the criteria. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found matching the criteria." });
            return;
        }

        students = students.map(s => ({ ...s, _uid: s.student_id }));

        console.log(`✅ Found and will process ${students.length} student(s).`);

        // STEP 2: Call config + transformation API
        console.log("📡 Fetching marksheet config + transformed data from API...");
        const apiRes = await fetch('https://demoschool-git-mkoct28tempheader-punit-diwans-projects.vercel.app/api/marksheetdataodt', {
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
        if (!apiRes.ok) {
            const bodyText = await apiRes.text();
            throw new Error(`Config API failed: ${bodyText}`);
        }
        const { transformedStudents } = await apiRes.json();
        if (!transformedStudents) {
            throw new Error(`Config API failed: missing transformedStudents in response.`);
        }
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        // STEP 3: Download template
        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        // STEP 4: Render ODT & convert to PDF

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = transformedStudents[i];
            transformedData = cleanData(transformedData);

            console.log(`📝 Processing student: ${student.full_name}`);

            // Replace images in ODT
            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, schoolDetails, tempDir);

            const dataForCarbone = {
                ...transformedData,
                school: schoolDetails
            };

            // --- 🔄 NEW: DYNAMIC SLOTS LOGIC ---
            // Prioritize the config from the API, but fall back to the environment variable for safety.
            const dynamicDetailsConfig = studentDetailsConfigFromApi;
            console.log("dynamicDetailsConfigdynamicDetailsConfig", dynamicDetailsConfig);

            const details = {};

            // Pre-fill a generous number of slots to prevent template errors
            for (let j = 1; j <= 25; j++) {
                details[`label${j}`] = '';
                details[`value${j}`] = '';
            }

            if (dynamicDetailsConfig && typeof dynamicDetailsConfig === 'string') {
                console.log('🔄 Processing dynamic student details slots...');
                try {
                    // The config value (from API or env) is a JSON string, so it needs to be parsed.
                    const config = JSON.parse(dynamicDetailsConfig);

                    if (Array.isArray(config)) {
                        // Loop through the configuration array
                        config.forEach((item, index) => {
                            const slotNumber = index + 1;
                            if (item.label && item.key) {
                                details[`label${slotNumber}`] = item.label;
                                details[`value${slotNumber}`] = transformedData[item.key] || '';
                            }
                        });
                        console.log('✅ Populated dynamic details successfully.');
                    } else {
                        console.warn('⚠️ Parsed dynamic config is not an array. Skipping.');
                    }
                } catch (e) {
                    console.warn(`⚠️ Could not parse the dynamic details configuration. It might be invalid JSON. Error: ${e.message}`);
                }
            } else {
                console.log('ℹ️ No dynamic student details configuration found to process.');
            }

            // Add the generated 'details' object to the main payload
            dataForCarbone.details = details;

            if (i === 0) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);

            // Convert to PDF
            const originalPdfPath = await convertOdtToPdf(odtFilename, outputDir);
            let finalPdfPath = originalPdfPath; // Default to the original PDF

            // ---: Conditionally apply the overlay
            if (applyOverlay) {
                const modifiedPdfPath = path.join(outputDir, `${fileSafeName}_modified.pdf`);
                await addWhiteOverlay(originalPdfPath, modifiedPdfPath, overlayOptions);
                finalPdfPath = modifiedPdfPath; // If overlay is applied, use the modified path for merging
            } else {
                console.log(`📜 Skipping white overlay for ${student.full_name} as per environment setting.`);
            }

            // Check for the existence of the final PDF to be used
            if (!require('fs').existsSync(finalPdfPath)) {
                console.error(`\n\n--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                console.error(`------------------------------------------------------------------\n\n`);
                throw new Error(`PDF generation failed for "${student.full_name}". Output file not found at: ${finalPdfPath}.`);
            }
            console.log(`✅ Successfully created final PDF for ${student.full_name}`);

            // Add the path of the final PDF to the array for merging
            pdfPaths.push(finalPdfPath);
        }

        // STEP 5: Merge, COMPRESS, & Upload
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
        const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

        if (pdfPaths.length > 0) {
            console.log('🔗 Merging all generated PDFs into one file...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created at: ${mergedPdfPath}`);

            await compressPdf(mergedPdfPath, compressedPdfPath);

            const originalSize = (await fs.stat(mergedPdfPath)).size / (1024 * 1024);
            const compressedSize = (await fs.stat(compressedPdfPath)).size / (1024 * 1024);
            console.log(`📊 Compression Results: Original size: ${originalSize.toFixed(2)} MB, Compressed size: ${compressedSize.toFixed(2)} MB`);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.readFile(compressedPdfPath);
            const formData = new FormData();

            formData.append('photo', fileBuffer, {
                filename: 'merged_output.pdf',
                contentType: 'application/pdf'
            });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`📤 Uploading compressed PDF to: ${filePath}`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) {
                const errorData = await uploadRes.text();
                throw new Error(`File upload API failed: ${errorData || uploadRes.statusText}`);
            }

            console.log("✅ File uploaded successfully. Updating job_history...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log('✅ job_history updated successfully.');
        } else {
            console.log('⚠️ No PDFs were generated to merge.');
        }

        console.log("🎉 Marksheets generated and uploaded successfully.");
    } catch (error) {
        console.error('❌ FATAL ERROR during marksheet generation:', error.message || error);
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