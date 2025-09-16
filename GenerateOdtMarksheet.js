// =================================================================
//          GenerateOdtMarksheet.js (Refactored - API Driven + Photos)
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

// ✨ UPDATED Function: More robust error handling for LibreOffice conversion
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

// 🔥 Fetch image and convert to base64
async function fetchImageAsBase64(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mimeType = url.endsWith(".png") ? "image/png" : "image/jpeg";
        return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch (err) {
        console.warn("⚠️ Could not fetch photo for student:", url, err.message);
        return null;
    }
}

// --- MAIN FUNCTION ---
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
        const studentIdsInput = process.env.STUDENT_IDS;

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables from GitHub Actions inputs.');
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

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

        // 🛡️ Additional validation
        students = students.filter(s => s && typeof s === 'object');           // filter null / non-objects
        students = students.filter(s => s.student_id);                        // ensure student_id exists

        if (students.length === 0) {
            console.warn("⚠️ No valid students found matching the criteria. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found matching the criteria." });
            return;
        }

        // Inject _uid
        students = students.map(s => ({ ...s, _uid: s.student_id }));

        console.log(`✅ Found and will process ${students.length} student(s).`);

        // STEP 2: Call config + transformation API
        console.log("📡 Fetching marksheet config + transformed data from API...");
        console.log("\n🔍 Debugging students before sending to marksheetdataodt API:");
        console.dir(students, { depth: null });

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
        const apiJson = await apiRes.json();

        if (!apiJson.transformedStudents) {
            console.error("❗️ API response missing `transformedStudents` field. Full response:");
            console.dir(apiJson, { depth: null });
            throw new Error(`Config API failed: missing transformedStudents in response.`);
        }

        const { transformedStudents } = apiJson;
        console.log("transformedStudents_mkp", transformedStudents[0]);
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        // STEP 3: Download template
        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        // STEP 4: Render ODT & convert to PDF
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            const transformedData = transformedStudents[i];

            // 🔥 Embed Base64 photo into transformed data
            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                transformedData.photo = await fetchImageAsBase64(student.photo);
            }

            console.log(`📝 Processing student: ${student.full_name}`);

            if (i === 0) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                console.log(JSON.stringify(transformedData, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            const odtReport = await carboneRender(templatePath, transformedData);

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);

            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);

            if (!fs.existsSync(pdfPath)) {
                console.error(`\n\n--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(transformedData, null, 2));
                console.error(`------------------------------------------------------------------\n\n`);
                throw new Error(`PDF generation failed for "${student.full_name}". Output file not found at: ${pdfPath}.`);
            }

            console.log(`✅ Successfully converted PDF for ${student.full_name}`);
            pdfPaths.push(pdfPath);
        }

        // STEP 5: Merge PDFs & Upload
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
        console.error('❌ FATAL ERROR during marksheet generation:', error.message || error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        process.exit(1);
    }
}

// --- EXECUTION ---
GenerateOdtFile();