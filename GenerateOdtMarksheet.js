// =================================================================
//          GenerateOdtMarksheet.js (Refactored - Batch Processing)
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

async function mergePdfs(pdfPaths, outputPath) {
    if (pdfPaths.length === 0) return;
    if (pdfPaths.length === 1) {
        // If there's only one PDF, just copy it instead of running pdftk
        await fs.promises.copyFile(pdfPaths[0], outputPath);
        return;
    }
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

/**
 * Converts batches of ODT files to merged PDFs using the Gotenberg API.
 * @param {string[]} odtPaths - An array of paths to the ODT files.
 * @param {string} outputDir - The directory to save the merged PDFs.
 * @param {number} batchSize - The number of files to process in each batch.
 * @returns {Promise<string[]>} A promise that resolves to an array of paths to the generated batch PDFs.
 */
async function convertOdtBatchesToPdf(odtPaths, outputDir, batchSize) {
    const generatedBatchPdfPaths = [];
    console.log(`\n🚀 Starting batch conversion of ${odtPaths.length} ODT files in batches of ${batchSize}...`);

    for (let i = 0; i < odtPaths.length; i += batchSize) {
        const batchNumber = i / batchSize + 1;
        const batchOdtPaths = odtPaths.slice(i, i + batchSize);
        console.log(`\n🔄 Processing Batch #${batchNumber} with ${batchOdtPaths.length} files...`);

        const formData = new FormData();
        batchOdtPaths.forEach(odtPath => {
            formData.append('files', fs.createReadStream(odtPath));
            console.log(`   - Adding ${path.basename(odtPath)} to batch.`);
        });

        formData.append('merge', 'true');

        formData.append('nativePageRanges', '1-');


        const url = "https://demo.gotenberg.dev/forms/libreoffice/convert";

        try {
            const response = await axios.post(url, formData, {
                headers: formData.getHeaders(),
                responseType: "stream",
                timeout: 180000, // 3 minutes timeout for larger batches
            });

            const pdfPath = path.join(outputDir, `batch_output_${batchNumber}.pdf`);
            const writer = fs.createWriteStream(pdfPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on("finish", resolve);
                writer.on("error", reject);
            });

            const stats = await fs.promises.stat(pdfPath);
            console.log(`✅ Batch #${batchNumber} successful! PDF created: ${pdfPath} (${stats.size} bytes)`);
            generatedBatchPdfPaths.push(pdfPath);

        } catch (err) {
            console.error(`❌ ERROR processing Batch #${batchNumber}. This batch will be skipped.`);
            if (err.response && err.response.data && typeof err.response.data.pipe === 'function') {
                let errorBody = '';
                for await (const chunk of err.response.data) {
                    errorBody += chunk.toString('utf8');
                }
                console.error("   - Gotenberg API Error:", errorBody);
            } else {
                console.error("   - Axios/Network Error:", err.message);
            }
        }
    }
    return generatedBatchPdfPaths;
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

        // --- STEP 1: Fetch student marks ---
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
        let students = (studentResponseJson.students || studentResponseJson.data || []).filter(s => s && s.student_id);
        if (students.length === 0) {
            console.warn("⚠️ No valid students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found." });
            return;
        }
        students = students.map(s => ({ ...s, _uid: s.student_id }));
        console.log(`✅ Found and will process ${students.length} student(s).`);

        // --- STEP 2: Call config + transformation API ---
        console.log("📡 Fetching marksheet config + transformed data...");
        const apiRes = await fetch('https://demoschool.edusparsh.com/api/marksheetdataodt', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _school: schoolId, groupIds, batchId, studentIds: students.map(s => s.student_id), students }),
        });
        if (!apiRes.ok) throw new Error(`Config API failed: ${await apiRes.text()}`);
        const { transformedStudents } = await apiRes.json();
        if (!transformedStudents) throw new Error(`Config API failed: missing transformedStudents.`);
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        // --- STEP 3: Download template ---
        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally: ${templatePath}`);

        // --- STEP 4: Generate ALL ODT files first ---
        console.log('\n--- Generating all individual ODT files ---');
        const odtPaths = [];
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = transformedStudents[i];

            transformedData = cleanData(transformedData);
            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                transformedData.photo = await fetchImageAsBase64(student.photo);
            }

            console.log(`📝 Generating ODT for: ${student.full_name}`);
            try {
                const odtReport = await carboneRender(templatePath, transformedData);
                const fileSafeName = student.full_name?.replace(/[\s/\\?%*:|"<>.]+/g, '_') || `student_${Date.now()}`;
                const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
                await fs.promises.writeFile(odtFilename, odtReport);
                odtPaths.push(odtFilename);
            } catch (err) {
                console.error(`⚠️ Failed to generate ODT for ${student.full_name}: ${err.message}`);
                await updateJobHistory(jobId, schoolId, { status: false, notes: `ODT failed for ${student.full_name}: ${err.message}`.substring(0, 200) });
            }
        }

        if (odtPaths.length === 0) {
            throw new Error("❌ No ODT files were successfully generated. Cannot proceed.");
        }

        // --- STEP 5: Convert ODTs to PDFs in Batches ---
        const batchPdfPaths = await convertOdtBatchesToPdf(odtPaths, outputDir, 4); // Adjust batch size if needed

        // --- STEP 6: Merge Batch PDFs & Upload ---
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');

        if (batchPdfPaths.length > 0) {
            console.log(`\n🧩 Merging ${batchPdfPaths.length} batch PDF(s) into final document...`);
            await mergePdfs(batchPdfPaths, mergedPdfPath);
            console.log(`✅ Final merged PDF created at: ${mergedPdfPath}`);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            const formData = new FormData();

            formData.append('photo', fileBuffer, { filename: 'merged_output.pdf', contentType: 'application/pdf' });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`📤 Uploading final merged PDF to: ${filePath}`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) {
                throw new Error(`File upload API failed: ${await uploadRes.text()}`);
            }

            console.log("✅ File uploaded. Updating job_history...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });
            console.log('✅ job_history updated.');
        } else {
            throw new Error('❌ No PDFs were generated from the batch conversion process. Upload failed.');
        }

        console.log("\n🎉 Marksheets generated and uploaded successfully.");

    } catch (error) {
        console.error('❌ FATAL ERROR during marksheet generation:', error.message || error);
        if (jobId && schoolId) {
            await updateJobHistory(jobId, schoolId, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
        }
        // process.exit(1); // Exit with an error code to fail the CI/CD job
    }
}

// --- EXECUTION ---
GenerateOdtFile();