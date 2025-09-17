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
const axios = require("axios");
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

// ✨ MODIFIED Function: More robust error logging for LibreOffice conversion
async function convertOdtToPdf(odtPath, outputDir) {
    try {
        const absOdtPath = path.resolve(odtPath);
        const absOutputDir = path.resolve(outputDir);

        if (!fs.existsSync(absOdtPath)) {
            throw new Error(`ODT file not found: ${absOdtPath}`);
        }

        if (!fs.existsSync(absOutputDir)) {
            fs.mkdirSync(absOutputDir, { recursive: true });
        }

        console.log(`🔄 Uploading ${path.basename(absOdtPath)} to Gotenberg API for conversion...`);

        const formData = new FormData();
        formData.append("files", fs.createReadStream(absOdtPath), {
            filename: path.basename(absOdtPath),
            contentType: "application/vnd.oasis.opendocument.text",
        });

        const url = "https://demo.gotenberg.dev/forms/libreoffice/convert";

        const response = await axios.post(url, formData, {
            headers: formData.getHeaders(),
            responseType: "stream",
            timeout: 60000,
        });

        const pdfPath = path.join(
            absOutputDir,
            path.basename(absOdtPath).replace(/\.odt$/i, ".pdf")
        );

        const writer = fs.createWriteStream(pdfPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });

        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF not created at: ${pdfPath}`);
        }

        const stats = await fs.promises.stat(pdfPath);
        console.log(`✅ PDF generated via API: ${pdfPath} (${stats.size} bytes)`);

        return pdfPath;
    } catch (err) {
        // Capture detailed error message from Gotenberg's response body
        if (err.response && err.response.data && typeof err.response.data.pipe === 'function') {
            const errorStream = err.response.data;
            let errorBody = '';
            // Asynchronously read the stream
            for await (const chunk of errorStream) {
                errorBody += chunk.toString('utf8');
            }
            console.error("❌ API conversion error from Gotenberg:", errorBody);
            throw new Error(`Gotenberg API failed: ${errorBody}`);
        } else {
            console.error("❌ API conversion error:", err.message);
            throw err;
        }
    }
}

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    const command = `pdftk ${pdfPaths.map(p => `"${p}"`).join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

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

// ✨ NEW: Robust recursive data cleaning function
function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) {
        return ''; // Replace null, undefined, and numeric NaN with a safe value
    }

    if (Array.isArray(data)) {
        return data.map(item => cleanData(item)); // Recurse into arrays
    }

    if (typeof data === 'object') {
        const cleanedObject = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                // Also check for the string 'NaN' which you observed in logs
                if (data[key] === 'NaN') {
                    cleanedObject[key] = '';
                } else {
                    cleanedObject[key] = cleanData(data[key]); // Recurse into object properties
                }
            }
        }
        return cleanedObject;
    }

    return data; // Return primitives (string, boolean, valid number) as-is
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
            let transformedData = transformedStudents[i];

            // ✨ MODIFIED: Use the new robust cleaning function
            console.log("🧼 Cleaning data for student:", student.full_name);
            transformedData = cleanData(transformedData);

            // Embed Base64 photo
            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                transformedData.photo = await fetchImageAsBase64(student.photo);
            }

            console.log(`📝 Processing student: ${student.full_name}`);

            try {
                const odtReport = await carboneRender(templatePath, transformedData);
                const fileSafeName = student.full_name?.replace(/[\s/\\?%*:|"<>.]+/g, '_') || `student_${Date.now()}`; // Made file name safer
                const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
                await fs.promises.writeFile(odtFilename, odtReport);

                // --- Verify ODT exists & log size ---
                if (fs.existsSync(odtFilename)) {
                    const stats = await fs.promises.stat(odtFilename);
                    console.log(`📂 ODT file generated: ${odtFilename} (${stats.size} bytes)`);
                } else {
                    console.error(`❌ ODT file missing: ${odtFilename}`);
                    continue; // skip this student
                }

                // ✅ Try conversion
                console.log(`🔄 Running conversion for: ${fileSafeName}.odt`);
                let pdfPath;
                try {
                    pdfPath = await convertOdtToPdf(odtFilename, outputDir);
                } catch (convErr) {
                    console.error(`❌ Conversion failed for ${student.full_name}:`, convErr.message);
                    continue;
                }


                // --- Verify PDF exists ---
                if (fs.existsSync(pdfPath)) {
                    const stats = await fs.promises.stat(pdfPath);
                    console.log(`✅ Successfully converted PDF for ${student.full_name} (${stats.size} bytes)`);
                    pdfPaths.push(pdfPath);
                } else {
                    console.error(`⚠️ PDF not found for ${student.full_name}, skipping.`);
                    continue;
                }


            } catch (err) {
                console.error(`⚠️ Failed to generate PDF for ${student.full_name}: ${err.message}`);
                // Skip this student but continue workflow
                await updateJobHistory(jobId, schoolId, { status: false, notes: `PDF failed for ${student.full_name}: ${err.message}`.substring(0, 200) });
                continue;
            }
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
        // process.exit(1);
    }
}

// --- EXECUTION ---
GenerateOdtFile();