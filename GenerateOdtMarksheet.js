// =================================================================
//          GenerateOdtMarksheet.js (Refactored - API Driven)
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

async function GenerateOdtFile() {
    let outputDir = '';
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

        console.log("school id present in the data is", schoolId);

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables from GitHub Actions inputs.');
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

        // ========================
        // STEP 1: Fetch student marks from your API
        // ========================
        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            currentdata: { division_id: DIVISION_ID, ranking_id: RANKING_ID }
        };

        console.log("📥 Fetching student data...");
        console.log('Marks Payload:', JSON.stringify(marksPayload, null, 2));

        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(marksPayload),
        });

        const responseText = await studentResponse.text();

        if (!studentResponse.ok) {
            console.error('Raw API Response:', responseText);
            throw new Error(`Failed to fetch student data: ${responseText}`);
        }

        const studentResponseJson = JSON.parse(responseText);
        const students = studentResponseJson.students || studentResponseJson.data || [];

        if (!Array.isArray(students) || students.length === 0) {
            console.warn("⚠️ No students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found." });
            return;
        }
        console.log(`✅ Found ${students.length} students.`);

        const studentIds = students.map(s => s.student_id);

        // ========================
        // STEP 2: Call internal API for config + transformation
        // ========================
        console.log("📡 Fetching marksheet config + transformed data from API...");

        const apiRes = await fetch('https://demoschool.edusparsh.com/api/marksheetdataodt', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                _school: schoolId,
                groupIds,
                batchId,
                studentIds,
                students,
            }),
        });

        if (!apiRes.ok) {
            const errText = await apiRes.text();
            throw new Error(`Config API failed: ${errText}`);
        }

        const { transformedStudents } = await apiRes.json();

        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        // ========================
        // STEP 3: Download template
        // ========================
        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        // ========================
        // STEP 4: Render ODT & convert to PDF
        // ========================
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            const transformedData = transformedStudents[i];

            console.log(`📝 Processing student: ${student.full_name}`);

            // --- START: NEW IMAGE PRE-DOWNLOAD LOGIC ---
            let tempImagePath = null; // To keep track of the temp file for cleanup
            try {
                // Check if there is a valid photo URL to process
                if (transformedData.photo && typeof transformedData.photo === 'string' && transformedData.photo.includes('.')) {
                    const photoUrl = transformedData.photo;
                    console.log(`   Downloading image from: ${photoUrl}`);

                    // 1. Download the image using node-fetch
                    const imageBuffer = await downloadFile(photoUrl);

                    // 2. Save it to a temporary local file
                    const extension = photoUrl.split('.').pop()?.toLowerCase() || 'png';
                    tempImagePath = path.join(outputDir, `temp_photo_${student.student_id}.${extension}`);
                    await fs.promises.writeFile(tempImagePath, imageBuffer);
                    console.log(`   Image saved locally to: ${tempImagePath}`);

                    // 3. Update the data for Carbone to use the LOCAL PATH
                    transformedData.photo = {
                        d: tempImagePath, // Use the local file path
                        w: 100,
                        h: 120
                        // Mimetype is not needed for local files, Carbone infers it
                    };

                } else {
                    // If the photo URL is missing or invalid, remove the key
                    delete transformedData.photo;
                    console.log('   No valid photo URL found for this student.');
                }

                // --- END: NEW IMAGE PRE-DOWNLOAD LOGIC ---

                if (i === 0) {
                    console.log(`\n\n--- DEBUG: TRANSFORMED DATA for ${student.full_name} ---`);
                    console.log(JSON.stringify(transformedData, null, 2));
                    console.log(`---------------------------------------------------\n\n`);
                }

                const odtReport = await carboneRender(templatePath, transformedData);

                const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
                const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
                await fs.promises.writeFile(odtFilename, odtReport);

                const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
                pdfPaths.push(pdfPath);

            } finally {
                // 4. Clean up the temporary image file after rendering is complete
                if (tempImagePath) {
                    await fs.promises.unlink(tempImagePath);
                    console.log(`   Cleaned up temporary image: ${tempImagePath}`);
                }
            }
        }
        // ========================
        // STEP 5: Merge PDFs & Upload
        // ========================
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');

        if (pdfPaths.length > 0) {
            await mergePdfs(pdfPaths, mergedPdfPath);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            const formData = new FormData();

            formData.append('photo', fileBuffer, {
                filename: 'merged_output.pdf',
                contentType: 'application/pdf'
            });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`📤 Uploading merged PDF to: ${filePath}`);
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
        console.error('❌ FATAL ERROR during marksheet generation:', error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        process.exit(1);
    }
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
    await execPromise(command);
    return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

// --- EXECUTION ---
GenerateOdtFile();