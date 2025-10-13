// =================================================================
//          GenerateOdtMarksheet.js (Final Corrected Version)
// =================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const FormData = require('form-data');
require('dotenv').config();

// Register all of Carbone's built-in formatters (like :image) globally.
carbone.addFormatters({
    image: function (data) {
        // Handle base64 data URIs
        if (typeof data === 'string' && data.startsWith('data:image')) {
            return data;
        }
        // Handle file paths
        if (typeof data === 'string' && !data.startsWith('http')) {
            return data;
        }
        // Return empty for invalid data
        return '';
    }
});
carbone.addFormatters(carbone.formatters);

const execPromise = util.promisify(exec);

// --- UTILITY FUNCTIONS ---

/**
 * A robust async wrapper for Carbone's render method.
 * This avoids context issues with util.promisify and ensures formatters are found.
 * @param {string} templatePath - The path to the ODT template.
 * @param {object} data - The data object to inject into the template.
 * @returns {Promise<Buffer>} - A promise that resolves with the rendered report buffer.
 */
function renderCarboneAsync(templatePath, data) {
    return new Promise((resolve, reject) => {
        carbone.render(templatePath, data, (err, result) => {
            if (err) {
                return reject(err);
            }
            resolve(result);
        });
    });
}

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
        if (stderr) console.warn(`[LibreOffice STDERR for ${path.basename(odtPath)}]:`, stderr);
        return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
    } catch (error) {
        console.error(`❌ LibreOffice command failed for ${path.basename(odtPath)}.`);
        console.error('--- STDOUT ---', error.stdout);
        console.error('--- STDERR ---', error.stderr);
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
        console.error('--- STDOUT ---', error.stdout);
        console.error('--- STDERR ---', error.stderr);
        throw new Error(`Ghostscript compression failed. See logs above.`);
    }
}

/**
 * Fetches an image from a URL and converts it to a Base64 data URI.
 * Crucially, it reads the 'content-type' header to determine the correct MIME type.
 * @param {string} url - The URL of the image to fetch.
 * @returns {Promise<string|null>} - A promise that resolves with the Base64 data URI or null on failure.
 */
async function fetchImageAsBase64(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch image (status ${res.status}): ${url}`);
        }
        const mimeType = res.headers.get('content-type');
        if (!mimeType || !mimeType.startsWith('image/')) {
            console.warn(`⚠️ URL did not return a valid image content-type. Got: "${mimeType}". URL: ${url}`);
            return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch (err) {
        console.warn("⚠️ Could not fetch photo for student:", url, err.message);
        return null;
    }
}

function cleanData(data) {
    if (data === null || data === undefined || (typeof data === 'number' && isNaN(data))) return '';
    if (Array.isArray(data)) return data.map(item => cleanData(item));
    if (typeof data === 'object') {
        const cleanedObject = {};
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                cleanedObject[key] = (data[key] === 'NaN' || data[key] === 'NaN') ? '' : cleanData(data[key]);
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

        const groupid = process.env.GROUP_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");
        const studentIdsInput = process.env.STUDENT_IDS;

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('❌ Missing required environment variables.');
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

        console.log("🏫 Fetching school details...");
        const schoolDetailsResponse = await fetch('https://demoschool.edusparsh.com/api/get_School_Detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ school_id: schoolId }),
        });
        if (!schoolDetailsResponse.ok) throw new Error(`Failed to fetch school details: ${await schoolDetailsResponse.text()}`);
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

        if (studentIdsInput) {
            const requestedStudentIds = new Set(studentIdsInput.split(','));
            console.log(`API returned ${students.length} students. Now filtering for the ${requestedStudentIds.size} requested student(s).`);
            students = students.filter(student => student && student.student_id && requestedStudentIds.has(student.student_id));
        }

        students = students.filter(s => s && typeof s === 'object' && s.student_id);
        if (students.length === 0) {
            console.warn("⚠️ No valid students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No valid students found matching criteria." });
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
        if (!apiRes.ok) throw new Error(`Config API failed: ${await apiRes.text()}`);
        const { transformedStudents } = await apiRes.json();
        if (!transformedStudents) throw new Error(`Config API failed: missing transformedStudents in response.`);
        console.log(`✅ Got transformed data for ${transformedStudents.length} students.`);

        console.log("📥 Downloading template...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = cleanData(transformedStudents[i]);

            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                transformedData.photo = await fetchImageAsBase64(student.photo);
            }

            const dataForCarbone = { ...transformedData, school: schoolDetails };

            console.log(`📝 Processing student: ${student.full_name}`);
            if (i === 0) {
                console.log(`\n\n--- DEBUG: COMBINED DATA FOR CARBONE (${student.full_name}) ---`);
                const logData = { ...dataForCarbone };
                if (logData.photo && logData.photo.length > 100) {
                    logData.photo = logData.photo.substring(0, 100) + '... [TRUNCATED]';
                }
                console.log(JSON.stringify(logData, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            // Using the new robust async wrapper
            const odtReport = await renderCarboneAsync(templatePath, dataForCarbone);

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);

            if (!fs.existsSync(pdfPath)) {
                console.error(`\n\n--- ❌ DEBUG DATA that caused failure for ${student.full_name} ---`);
                console.error(JSON.stringify(dataForCarbone, null, 2));
                console.error(`------------------------------------------------------------------\n\n`);
                throw new Error(`PDF generation failed for "${student.full_name}".`);
            }

            console.log(`✅ Successfully converted PDF for ${student.full_name}`);
            pdfPaths.push(pdfPath);
        }

        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
        const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');
        if (pdfPaths.length > 0) {
            console.log('🔗 Merging all generated PDFs...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created at: ${mergedPdfPath}`);

            await compressPdf(mergedPdfPath, compressedPdfPath);

            const originalSize = (await fs.promises.stat(mergedPdfPath)).size / (1024 * 1024);
            const compressedSize = (await fs.promises.stat(compressedPdfPath)).size / (1024 * 1024);
            console.log(`📊 Compression: Original: ${originalSize.toFixed(2)} MB, Compressed: ${compressedSize.toFixed(2)} MB`);

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
            if (!uploadRes.ok) throw new Error(`File upload API failed: ${await uploadRes.text() || uploadRes.statusText}`);

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
    }
}

// --- EXECUTION ---
GenerateOdtFile();