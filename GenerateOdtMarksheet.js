// =================================================================
//          GenerateOdtMarksheet.js (Refactored - API Driven + Photos + Compression + School Details)
// =================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const FormData = require('form-data');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);

const sharp = require("sharp");

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


/**
 * ✨ NEW: Downloads an image, converts it to PNG, and saves it locally.
 * This is a more robust method for image insertion with Carbone.
 * @param {string} url - The URL of the image to download.
 * @param {string} studentId - The unique ID of the student for a unique filename.
 * @param {string} outputDir - The directory to save the image in.
 * @returns {Promise<string|null>} The local path to the saved image, or null on failure.
 */
async function downloadAndPrepareImage(url, studentId, outputDir) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url} (${res.status})`);

        // node-fetch v2 uses .buffer(), v3 uses .arrayBuffer()
        const buffer = await (res.buffer ? res.buffer() : Buffer.from(await res.arrayBuffer()));

        const imagePath = path.join(outputDir, `photo_${studentId}.png`);

        // Use sharp to process the image: resize for consistency and convert to PNG for reliability
        await sharp(buffer)
            .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(imagePath);

        console.log(`🖼️  Photo for student ${studentId} saved to ${imagePath}`);
        return imagePath; // Return the local file path
    } catch (err) {
        console.warn(`⚠️ Could not download or process photo for student ${studentId}:`, url, err.message);
        return null; // Return null on failure, Carbone will just skip it.
    }
}


function cleanData(data) {
    // ... (This function remains unchanged)
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
    const jobId = process.env.JOB_ID;
    const schoolId = process.env.SCHOOL_ID;

    try {
        console.log("🚀 Starting dynamic marksheet generation with Carbone...");

        // ... (Environment variable fetching remains the same)
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
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

        // ... (School Details and Student Marks fetching remains the same)
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
        console.log("students data from cce marks api", students[0]);
        if (studentIdsInput) {
            const requestedStudentIds = new Set(studentIdsInput.split(','));
            console.log(`API returned ${students.length} students. Now filtering for the ${requestedStudentIds.size} requested student(s).`);
            students = students.filter(student => student && student.student_id && requestedStudentIds.has(student.student_id));
        }
        students = students.filter(s => s && typeof s === 'object' && s.student_id);
        if (students.length === 0) {
            console.warn("⚠️ No valid students found matching the criteria. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found matching the criteria." });
            return;
        }
        students = students.map(s => ({ ...s, _uid: s.student_id }));
        console.log(`✅ Found and will process ${students.length} student(s).`);

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

        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        // STEP 4: Render ODT & convert to PDF
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);

            // ✨ CHANGE: Download the photo and get the local path
            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                // This now returns a file path like 'output/photo_student123.png' or null
                transformedData.photo = await downloadAndPrepareImage(student.photo, student.student_id, outputDir);
            } else {
                transformedData.photo = null; // Ensure photo field exists but is null if no photo URL
            }

            const dataForCarbone = {
                ...transformedData,
                school: schoolDetails
            };

            console.log(`📝 Processing student: ${student.full_name}`);

            if (i === 0) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                // Note: The 'photo' field will now be a file path, not a base64 string.
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            // ✨ CHANGE: Add options object to tell Carbone how to handle the photo
            const carboneOptions = {
                convertTo: {
                    photo: 'image' // Tells Carbone to treat the 'photo' field value as an image path
                }
            };

            const odtReport = await carboneRender(templatePath, dataForCarbone, carboneOptions);
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);

            if (!fs.existsSync(pdfPath)) {
                console.error(`\n\n--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                console.error(`------------------------------------------------------------------\n\n`);
                throw new Error(`PDF generation failed for "${student.full_name}". Output file not found at: ${pdfPath}.`);
            }
            console.log(`✅ Successfully converted PDF for ${student.full_name}`);
            pdfPaths.push(pdfPath);
        }

        // ... (Merging, Compressing, and Uploading remains the same)
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
        const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

        if (pdfPaths.length > 0) {
            console.log('🔗 Merging all generated PDFs into one file...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created at: ${mergedPdfPath}`);

            await compressPdf(mergedPdfPath, compressedPdfPath);

            const originalSize = (await fs.promises.stat(mergedPdfPath)).size / (1024 * 1024);
            const compressedSize = (await fs.promises.stat(compressedPdfPath)).size / (1024 * 1024);
            console.log(`📊 Compression Results: Original size: ${originalSize.toFixed(2)} MB, Compressed size: ${compressedSize.toFixed(2)} MB`);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(compressedPdfPath);
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
        // process.exit(1);
    }
}

// --- EXECUTION ---
GenerateOdtFile();