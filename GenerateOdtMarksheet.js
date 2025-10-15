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

async function convertOdtToPdf(odtPath, outputDir) {
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" --infilter="writer_pdf_Export" "${odtPath}"`;
    try {
        console.log(`🔄 Running conversion for: ${path.basename(odtPath)} with recovery attempt`);
        const { stdout, stderr } = await execPromise(command);

        if (stderr) {
            console.warn(`[LibreOffice STDERR for ${path.basename(odtPath)}]:`, stderr);
        }

        const pdfPath = path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF output not created at: ${pdfPath}`);
        }
        return pdfPath;
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

// ✨ NEW Function: Compress PDF using Ghostscript
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

// --- NEW FUNCTION: Process ODT Template ---
async function processOdtTemplate(templatePath, tempDir) {
    const tempOdtDir = path.join(tempDir, 'odt_temp');
    const newOdtPath = path.join(tempDir, 'template_new.odt');

    // 1. Create temp folder and extract ODT contents
    await execPromise(`mkdir -p "${tempOdtDir}" && cd "${tempOdtDir}" && unzip "${templatePath}"`);
    console.log(`✅ Extracted template to ${tempOdtDir}`);

    // 2. Pretty-print content.xml (optional, skip if xmllint not found)
    const contentXmlPath = path.join(tempOdtDir, 'content.xml');
    try {
        await execPromise(`xmllint --format "${contentXmlPath}" -o "${contentXmlPath}"`);
        console.log(`✅ Formatted content.xml`);
    } catch (err) {
        console.warn(`⚠️ xmllint not found or formatting failed: ${err.message}. Using unformatted content.xml.`);
    }

    // 3. Repack into a new ODT (mimetype first, uncompressed)
    await execPromise(`cd "${tempOdtDir}" && zip -0 "${newOdtPath}" mimetype`);
    await execPromise(`cd "${tempOdtDir}" && zip -r "${newOdtPath}" * -x mimetype`);
    console.log(`✅ Repacked new ODT to ${newOdtPath}`);

    // Wait for the file to be fully written
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!fs.existsSync(newOdtPath)) {
        throw new Error(`Failed to create new ODT at ${newOdtPath}`);
    }

    return newOdtPath;
}

// --- MAIN FUNCTION ---
async function GenerateOdtFile() {
    let outputDir = '';
    let tempDir = ''; // Declare tempDir at function scope
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
        tempDir = path.join(outputDir, 'temp');
        await fs.promises.mkdir(tempDir, { recursive: true });
        const pdfPaths = [];

        // ✨ STEP 0: NEW - Fetch School Details
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

        console.log("students data from cce marks api", students[0]);

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
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`✅ Template saved locally to: ${templatePath}`);

        // Process the template
        const processedTemplatePath = await processOdtTemplate(templatePath, tempDir).catch(err => {
            console.error(`❌ Failed to process template: ${err.message}. Using original template.`);
            return templatePath; // Fallback to original template if processing fails
        });

        // STEP 4: Render ODT & convert to PDF
        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            let transformedData = transformedStudents[i];
            transformedData = cleanData(transformedData);
            if (student.photo && student.photo !== "-" && student.photo.startsWith("http")) {
                transformedData.photo = await fetchImageAsBase64(student.photo);
                // Log image size to debug potential corruption
                if (transformedData.photo) {
                    const base64Data = transformedData.photo.split(',')[1];
                    const buffer = Buffer.from(base64Data, 'base64');
                    console.log(`📸 Image size for ${student.full_name}: ${buffer.length} bytes`);
                }
            }

            // ✨ NEW: Combine student's transformed data with the general school details
            const dataForCarbone = {
                ...transformedData,
                school: schoolDetails
            };

            console.log(`📝 Processing student: ${student.full_name}`);

            if (i === 0) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA (${student.full_name}) ---`);
                console.log(JSON.stringify(dataForCarbone, null, 2));
                console.log(`---------------------------------------------------\n\n`);
            }

            const odtReport = await carboneRender(processedTemplatePath, dataForCarbone);
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            console.log(`✅ ODT content for ${student.full_name} written to ${odtFilename}`);
            await fs.promises.writeFile(odtFilename, odtReport);

            // Validate ODT by attempting to open it with LibreOffice in repair mode
            try {
                await execPromise(`libreoffice --headless --convert-to odt:"writer8" --infilter="writer8" "${odtFilename}"`);
                console.log(`✅ Validated ODT for ${student.full_name}`);
            } catch (validationError) {
                console.warn(`⚠️ ODT validation failed for ${student.full_name}: ${validationError.message}. Attempting conversion anyway.`);
            }

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

        // STEP 5: Merge, COMPRESS, & Upload
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');
        const compressedPdfPath = path.join(outputDir, 'merged_compressed.pdf');

        if (pdfPaths.length > 0) {
            console.log('🔗 Merging all generated PDFs into one file...');
            await mergePdfs(pdfPaths, mergedPdfPath);
            console.log(`✅ Merged PDF created at: ${mergedPdfPath}`);

            // 🔥 NEW COMPRESSION STEP
            await compressPdf(mergedPdfPath, compressedPdfPath);

            // Optional: Log file size comparison
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
    } finally {
        // Clean up temp directory
        if (tempDir) {
            await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
                console.warn(`⚠️ Failed to clean up temp directory: ${err.message}`);
            });
        }
    }
}

// --- EXECUTION ---
GenerateOdtFile();