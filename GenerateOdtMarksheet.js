const fs = require('fs').promises; // Fixed import
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const FormData = require('form-data');
const yauzl = require('yauzl');
const yazl = require('yazl');
const sharp = require('sharp');
const xml2js = require('xml2js');
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
        // Convert to JPEG to match template image format
        return await sharp(buffer).jpeg().toBuffer();
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

async function findStudentImageFilename(contentXmlPath, picturesDir) {
    try {
        const contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        const parsedXml = await parseXml(contentXml);
        // Navigate to text:p elements under office:text
        const textElements = parsedXml['office:document-content']?.['office:body']?.[0]?.['office:text']?.[0]?.['text:p'] || [];
        console.log(`DEBUG: Found ${textElements.length} text:p elements in content.xml`);

        for (const textP of textElements) {
            const drawFrames = textP['draw:frame'] || [];
            for (const frame of drawFrames) {
                const image = frame['draw:image']?.[0];
                if (image && image['$']?.['draw:name'] === 'studentImage') {
                    const href = image['$']?.['xlink:href'];
                    console.log(`DEBUG: Found draw:image with draw:name="studentImage", href=${href}`);
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
        }
        console.warn(`⚠️ No student image with draw:name="studentImage" found in content.xml.`);
        return null;
    } catch (err) {
        console.error(`❌ Failed to parse content.xml or read Pictures directory:`, err);
        return null;
    }
}

async function replaceImageInOdt(templatePath, student, tempDir) {
    if (!student.photo || student.photo === "-" || !student.photo.startsWith("http")) {
        console.log(`⚠️ No valid photo URL for ${student.full_name}. Using original template.`);
        return templatePath;
    }

    const imageBuffer = await fetchImage(student.photo);
    if (!imageBuffer) {
        console.log(`⚠️ Failed to fetch image for ${student.full_name}. Using original template.`);
        return templatePath;
    }

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
        // Log Pictures directory contents
        const picturesDir = path.join(studentDir, 'Pictures');
        try {
            const pictureFiles = await fs.readdir(picturesDir);
            console.log(`DEBUG: Pictures directory contents: ${pictureFiles.join(', ')}`);
        } catch (err) {
            console.warn(`⚠️ Pictures directory not found or empty:`, err.message);
        }
    } catch (err) {
        console.error(`❌ Failed to unzip template for ${student.full_name}:`, err);
        return templatePath;
    }

    // Find the student image filename from content.xml
    const contentXmlPath = path.join(studentDir, 'content.xml');
    const picturesDir = path.join(studentDir, 'Pictures');
    const imageFilename = await findStudentImageFilename(contentXmlPath, picturesDir);
    if (!imageFilename) {
        console.warn(`⚠️ No student image found for ${student.full_name}. Using original template.`);
        return templatePath;
    }
    console.log(`✅ Found student image filename: ${imageFilename}`);

    // Replace image with the found filename
    const imagePathInOdt = path.join(studentDir, 'Pictures', imageFilename);
    await fs.mkdir(path.join(studentDir, 'Pictures'), { recursive: true });
    await fs.writeFile(imagePathInOdt, imageBuffer);
    console.log(`✅ Wrote image to ${imagePathInOdt}`);

    // Update content.xml to ensure it references the correct image file
    try {
        let contentXml = await fs.readFile(contentXmlPath, 'utf-8');
        contentXml = contentXml.replace(new RegExp(`Pictures/[^"]+\\.(png|jpg|jpeg)(?="[^>]*draw:name="studentImage")`, 'i'), `Pictures/${imageFilename}`);
        await fs.writeFile(contentXmlPath, contentXml);
        console.log(`✅ Updated content.xml for ${student.full_name}`);
    } catch (err) {
        console.error(`❌ Failed to update content.xml for ${student.full_name}:`, err);
        return templatePath;
    }

    // Re-zip to create new ODT
    const newOdtPath = path.join(tempDir, `${student.full_name?.replace(/\s+/g, '_') || student.student_id}.odt`);
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

        // Wait for the file to be fully written
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
        const schoolDetails = cleanData(await schoolDetailsResponse.json());
        console.log("✅ School details fetched successfully.");

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

            // Replace image in ODT
            const modifiedOdtPath = await replaceImageInOdt(templatePath, student, tempDir);

            const dataForCarbone = {
                ...transformedData,
                school: schoolDetails
            };

            if (i === 0) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            const odtReport = await carboneRender(modifiedOdtPath, dataForCarbone);
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.writeFile(odtFilename, odtReport);
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);

            if (!require('fs').existsSync(pdfPath)) {
                console.error(`\n\n--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                console.error(`------------------------------------------------------------------\n\n`);
                throw new Error(`PDF generation failed for "${student.full_name}". Output file not found at: ${pdfPath}.`);
            }
            console.log(`✅ Successfully converted PDF for ${student.full_name}`);
            pdfPaths.push(pdfPath);
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