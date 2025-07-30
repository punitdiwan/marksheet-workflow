const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const yauzl = require('yauzl');
const yazl = require('yazl');
require('dotenv').config(); // Load environment variables


const execPromise = util.promisify(exec);

async function GenerateOdtFile() {
    let outputDir = '';
    try {

        console.log("try start");

        // Step 1: Get Payload
        const groupid = process.env.GROUP_ID;
        const _school = process.env.SCHOOL_ID;
        const batchId = process.env.BATCH_ID;
        const jobId = process.env.JOB_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const group = groupid?.split(",")

        if (!templateUrl || typeof templateUrl !== 'string') {
            throw new Error('Invalid or missing template URL in payload');
        }
        if (!_school || !batchId || !jobId) {
            throw new Error('Missing _school, batchId, or job_id in payload');
        }

        // Step 1.1: Fetch mappings dynamically
        const mappingResponse = await fetch('https://demoschool.edusparsh.com/api/getMarksheetMappings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                _school: _school,
                courseId: [courseId],
            }),
        });

        if (!mappingResponse.ok) {
            throw new Error(`Failed to fetch mappings: ${mappingResponse.statusText}`);
        }

        const mappingJson = await mappingResponse.json();
        let keyMapRaw = mappingJson.mappings || mappingJson.data || [];

        console.log("🔍 Received raw mapping data from API:", JSON.stringify(keyMapRaw, null, 2));

        if (!Array.isArray(keyMapRaw) || keyMapRaw.length === 0) {
            throw new Error('Mapping format from API is invalid or empty. The API returned no mappings.');
        }

        console.log("Searching for a suitable mapping...");

        // --- START: NEW ROBUST MAPPING LOGIC ---

        // 1. Filter by Course ID
        const courseMatches = keyMapRaw.filter(entry => {
            if (!entry || !entry.courses) return false;
            return Array.isArray(entry.courses) ? entry.courses.includes(courseId) : entry.courses === courseId;
        });

        if (courseMatches.length === 0) {
            throw new Error(`No mapping entries found for courseId: ${courseId}.`);
        }
        console.log(`Found ${courseMatches.length} mapping(s) for courseId: ${courseId}.`);

        // 2. Filter by Template File Type (e.g., 'odt')
        const templateExtension = path.extname(templateUrl).substring(1);
        let templateTypeMatches = courseMatches.filter(entry => entry.file_type === templateExtension);

        console.log(`Found ${templateTypeMatches.length} mapping(s) for template type '${templateExtension}'.`);

        // If no matches for the specific type, maybe the data is inconsistent. Widen the search.
        if (templateTypeMatches.length === 0) {
            console.warn(`No mappings found for exact type '${templateExtension}'. Using all course matches as a fallback pool.`);
            templateTypeMatches = courseMatches;
        }

        // 3. Find a specific batch match within the correct file type
        let selectedMappingEntry = templateTypeMatches.find(entry => {
            if (!entry.batches) return false;
            // Handle `batches` being a string OR an array
            return Array.isArray(entry.batches)
                ? entry.batches.includes(batchId)
                : entry.batches === batchId;
        });

        // 4. If a specific batch match is found, use it. Otherwise, use a smart fallback.
        if (selectedMappingEntry) {
            console.log(`✅ Found specific mapping for batchId: ${batchId} and template type: ${templateExtension}.`);
        } else {
            console.warn(`⚠️  Batch-specific mapping not found. Falling back to the first available general mapping for type '${templateExtension}'.`);
            // Fallback: Find the FIRST entry of the correct type that HAS valid mappings.
            selectedMappingEntry = templateTypeMatches.find(entry => entry && entry.mappings);
        }
        // --- END: NEW ROBUST MAPPING LOGIC ---

        // 5. Final validation
        if (!selectedMappingEntry || !selectedMappingEntry.mappings) {
            throw new Error(`Could not resolve a valid mapping with content for courseId: ${courseId} and template type: ${templateExtension}, even after fallback attempts.`);
        }

        let rawMappingStr = selectedMappingEntry.mappings;
        console.log("Selected raw mapping string:", rawMappingStr);

        rawMappingStr = rawMappingStr
            .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
            .replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=[,}])/g, ':"$1"');

        let keyMap;
        try {
            keyMap = JSON.parse(rawMappingStr);
        } catch (err) {
            console.error("⚠️ Failed to parse mappings JSON:", rawMappingStr);
            throw new Error('Failed to parse mappings JSON string from API');
        }


        // Step 2: Prepare directories and file lists
        outputDir = path.join('/tmp', `output_${Date.now()}`);
        await fs.promises.mkdir(outputDir, { recursive: true });

        const pdfPaths = [];
        const odtPaths = [];
        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');

        // Step 3: Fetch student data
        const marksPayload = {
            _school: _school,
            batchId: [batchId],
            group: group,
            "currentdata": {
                "division_id": DIVISION_ID,
                "ranking_id": RANKING_ID
            }
        };

        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(marksPayload),
        });

        if (!studentResponse.ok) {
            throw new Error(`Failed to fetch student data: ${studentResponse.statusText}`);
        }

        const studentResponseJson = await studentResponse.json();
        // console.log("📦 Raw student API response:", JSON.stringify(studentResponseJson, null, 2));
        let students = studentResponseJson.students;
        if (!Array.isArray(students)) {
            students = studentResponseJson.data || studentResponseJson.result?.students || [];
        }

        if (!Array.isArray(students)) {
            throw new Error('Could not resolve student array from response');
        }

        if (students.length === 0) {
            console.warn("⚠️ Warning: No students found for the given criteria. No marksheets will be generated.");
        } else {
            console.log(`Generating marksheets for ${students.length} students...`);
        }

        // Step 4: Generate ODTs and PDFs
        for (const student of students) {
            const transformedData = transformData(student, keyMap);
            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}_filled.odt`);

            await fillOdtTemplatePerfect(templateUrl, odtFilename, transformedData);
            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);

            odtPaths.push(odtFilename);
            pdfPaths.push(pdfPath);
        }

        console.log("Merging student marksheets...");

        let uploadedFileUrl = null;
        let filePath = null;
        if (pdfPaths.length > 0) {
            await mergePdfs(pdfPaths, mergedPdfPath);

            // Step 6: Upload to DigitalOcean Spaces
            filePath = `templates/marksheets/${_school}/result/${batchId}_${jobId}.pdf`;

            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            const formData = new FormData();
            formData.append('photo', fileBuffer, {
                filename: 'merged_output.pdf',
                contentType: 'application/pdf',
            });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) {
                const errorData = await uploadRes.text();
                throw new Error(`File upload failed: ${errorData || uploadRes.statusText}`);
            }

            const { data } = await uploadRes.json();
            uploadedFileUrl = `http://schoolerp-bucket.blr1.digitaloceanspaces.com/${filePath}`;

            console.log("Updating job_history table...");

            const jobUpdatePayload = {
                _school: _school,
                table: 'job_history',
                _uid: jobId,
                payload: {
                    file_path: filePath,
                    status: true,
                },
            };

            const jobUpdateRes = await fetch("https://demoschool.edusparsh.com/api/updatejobHistory", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(jobUpdatePayload),
            });

            if (!jobUpdateRes.ok) {
                const errorData = await jobUpdateRes.text();
                console.error(`Failed to update job_history: ${errorData || jobUpdateRes.statusText}`);
                throw new Error(`Failed to update job_history: ${errorData || jobUpdateRes.statusText}`);
            }

            const jobUpdateData = await jobUpdateRes.json();
            console.log('Job_history updated successfully:', jobUpdateData);
        } else {
            console.log('No PDFs were generated to merge.');
        }

        console.log("Marksheets generated and uploaded successfully");

        // Final response log
        console.log(JSON.stringify({
            message: 'Marksheets generated and uploaded successfully',
            pdfPath: uploadedFileUrl || mergedPdfPath,
            filePath: filePath,
        }));
    } catch (error) {
        console.error('Error generating marksheets:', error);
        console.error(`Failed to generate or upload marksheets: ${error.message}`);
        process.exit(1);
    } finally {
        if (outputDir && (await fs.promises.access(outputDir).then(() => true).catch(() => false))) {
            try {
                await fs.promises.rm(outputDir, { recursive: true, force: true });
                console.log(`Deleted directory: ${outputDir}`);
            } catch (err) {
                console.warn(`Failed to delete directory: ${outputDir}`, err);
            }
        }
    }
}

// Utility functions (no changes below this line)
function transformData(student, keyMap) {
    const result = {};
    for (const [newKey, oldKey] of Object.entries(keyMap)) {
        result[newKey] = student[oldKey] ?? '';
    }
    return result;
}

// Fill ODT template
async function fillOdtTemplatePerfect(inputUrl, outputPath, variables) {
    const templateBuffer = await downloadFile(inputUrl);
    const tempFiles = {};

    await new Promise((resolve, reject) => {
        yauzl.fromBuffer(templateBuffer, { lazyEntries: true }, (err, zipfile) => {
            if (err || !zipfile) return reject(err);
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                zipfile.openReadStream(entry, (err, readStream) => {
                    if (err || !readStream) return reject(err);
                    const chunks = [];
                    readStream.on('data', chunk => chunks.push(chunk));
                    readStream.on('end', () => {
                        tempFiles[entry.fileName] = Buffer.concat(chunks);
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.on('end', resolve);
        });
    });

    let contentXml = tempFiles['content.xml'].toString('utf8');
    contentXml = contentXml.replace(/>\s+</g, '><').replace(/<\/text:span><text:span[^>]*>/g, '');

    for (const [key, value] of Object.entries(variables)) {
        const safeValue = escapeXml(value);
        contentXml = contentXml.split(`{${key}}`).join(safeValue);
    }

    tempFiles['content.xml'] = Buffer.from(contentXml, 'utf8');

    const zipfile = new yazl.ZipFile();
    const output = fs.createWriteStream(outputPath);
    zipfile.outputStream.pipe(output);

    if (tempFiles['mimetype']) {
        zipfile.addBuffer(tempFiles['mimetype'], 'mimetype', { compress: false });
        delete tempFiles['mimetype'];
    }

    for (const [filename, content] of Object.entries(tempFiles)) {
        if (!filename.endsWith('/')) {
            zipfile.addBuffer(content, filename);
        }
    }

    zipfile.end();
    await new Promise(resolve => output.on('close', resolve));
}

// Download a file as buffer
async function downloadFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch file: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
}

// Escape XML special characters
function escapeXml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Convert ODT to PDF
async function convertOdtToPdf(odtPath, outputDir) {
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${odtPath}"`;
    await execPromise(command);
    return path.join(outputDir, path.basename(odtPath, '.odt') + '.pdf');
}

// Merge PDFs using pdftk
async function mergePdfs(pdfPaths, outputPath) {
    const command = `pdftk ${pdfPaths.join(' ')} cat output "${outputPath}"`;
    await execPromise(command);
}

// Call the main function
GenerateOdtFile()
    .then(() => {
        console.log("✅ Marksheets generated successfully.");
    })
    .catch((err) => {
        console.error("❌ Failed to generate marksheets:", err);
        process.exit(1);
    });
