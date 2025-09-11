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
        const schoolId = process.env.SCHOOL_ID;
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

        // ========================
        // STEP 1: Fetch student marks from your API
        // ========================
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
            students = students.filter(student => requestedStudentIds.has(student.student_id));
        }

        if (!Array.isArray(students) || students.length === 0) {
            console.warn("⚠️ No students found matching the criteria. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found matching the criteria." });
            return;
        }
        console.log(`✅ Found and will process ${students.length} student(s).`);

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

        if (!apiRes.ok) throw new Error(`Config API failed: ${await apiRes.text()}`);
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
        const pdfPaths = [];

        let studentIndex = 0;
        for (const student of students) {
            const transformedData = transformedStudents[studentIndex];
            console.log(`\n📝 Processing student ${studentIndex + 1}/${students.length}: ${student.full_name}`);

            if (studentIndex === 0) {
                console.log(`--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                console.log(JSON.stringify(transformedData, null, 2));
                console.log(`---------------------------------------------------\n`);
            }

            console.log(`   - Rendering ODT file...`);
            const odtReport = await carboneRender(templatePath, transformedData);

            const fileSafeName = student.full_name?.replace(/[\s/]/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);
            console.log(`   - ODT file saved: ${odtFilename}`);

            // This is the crucial change. We await the conversion completely for each student.
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
            pdfPaths.push(pdfPath);
            console.log(`   - PDF conversion complete: ${pdfPath}`);

            studentIndex++;
        }

        // ========================
        // STEP 5: Merge PDFs & Upload
        // ========================
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');

        if (pdfPaths.length > 0) {
            console.log(`\n🌀 Merging ${pdfPaths.length} PDF(s)...`);
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created at: ${mergedPdfPath}`);

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

        console.log("\n🎉 Marksheets generated and uploaded successfully.");

    } catch (error) {
        console.error('❌ FATAL ERROR during marksheet generation:', error);
        if (jobId) {
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
    // This function now robustly waits for the command to complete.
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${odtPath}"`;
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stderr) {
            console.warn(`[LibreOffice STDERR]: ${stderr}`);
        }
        // console.log(`[LibreOffice STDOUT]: ${stdout}`); // Optional: for debugging
        return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
    } catch (error) {
        console.error(`❌ Error converting ${odtPath} to PDF.`);
        throw error; // Rethrow the error to be caught by the main try/catch block
    }
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    if (pdfPaths.length === 1) {
        // If there's only one PDF, just copy it to the output path instead of using pdftk.
        console.log("Only one PDF generated, skipping merge and copying directly.");
        await fs.promises.copyFile(pdfPaths[0], outputPath);
        return;
    }
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

// --- EXECUTION ---
GenerateOdtFile();