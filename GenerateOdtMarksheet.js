// =================================================================
//          GenerateOdtMarksheet.js (Final Corrected Script)
// =================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const fetch = require('node-fetch');
const carbone = require('carbone');
const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
require('dotenv').config();

const execPromise = util.promisify(exec);
const carboneRender = util.promisify(carbone.render);

// --- START: HARDCODE YOUR SECRETS HERE FOR TESTING ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
// --- END: HARDCODE YOUR SECRETS HERE ---

const schemaName = process.env.SCHOOL_ID;

if (!schemaName) {
    throw new Error("FATAL: SCHOOL_ID (which is used as the schema name) is not defined in environment variables.");
}

console.log(`✅ Initializing Supabase client for schema: "${schemaName}"`);

const supabase = createClient(supabaseUrl, supabaseKey, {
    db: {
        schema: schemaName,
    },
});

async function fetchMarksheetConfig(groupIds) {
    console.log(`Fetching config for groups: ${groupIds}`);

    const { data: examGroups, error: groupsError } = await supabase
        .from('exam_groups')
        .select('_uid, group_code, name')
        .in('_uid', groupIds);
    if (groupsError) throw new Error(`Error fetching exam groups: ${groupsError.message}`);

    const { data: exams, error: examsError } = await supabase
        .from('cce_exams')
        .select('exam_code, name, examgroups, subjects!inner(_uid, sub_name, code)')
        .in('examgroups', groupIds);
    if (examsError) throw new Error(`Error fetching exams: ${examsError.message}`);

    const subjectsMap = new Map();
    exams.forEach(exam => {
        if (exam.subjects && !subjectsMap.has(exam.subjects._uid)) {
            subjectsMap.set(exam.subjects._uid, exam.subjects);
        }
    });
    const subjects = Array.from(subjectsMap.values());

    console.log(`Found ${subjects.length} unique subjects and ${exams.length} exams.`);
    return { examGroups, exams, subjects };
}


/**
 * Derives a short code (e.g., 'sc', 'en') from a subject object.
 * This is crucial because the incoming student data uses these short codes in its keys.
 * @param {object} subject - The subject object from the config { _uid, sub_name, code }.
 * @returns {string} - The derived short code in lowercase.
 */
function getSubjectShortCode(subject) {
    if (!subject || !subject.sub_name) return '';

    const name = subject.sub_name.toLowerCase();
    // Create a simple mapping for common subjects. You can expand this.
    const mappings = {
        'science': 'sc',
        'social science': 'so',
        'english': 'en',
        'hindi': 'hi',
        'maths': 'ma',
        'mathematics': 'ma',
        'sanskrit': 'sp',
        'practical': 'pr',
        'computer': 'co',
    };

    if (mappings[name]) {
        return mappings[name];
    }

    // Fallback logic: for "Social Science", take "so". For "English", take "en".
    const words = name.split(/\s+/);
    if (words.length > 1) {
        return words.map(w => w[0]).join(''); // "Social Science" -> "ss" (adjust if needed, e.g. "so")
    }
    return name.substring(0, 2); // "Hindi" -> "hi"
}


/**
 * Transforms the flat student data from the API into a nested structure suitable for Carbone templates.
 * @param {object} studentData - The raw data for a single student from the API.
 * @param {object} config - The configuration object containing subjects, exams, and exam groups.
 * @returns {object} - The structured data ready for Carbone.
 */

function transformStudentDataForCarbone(studentData, config) {
    // Start with a copy of all top-level student properties (full_name, dob, grand_percentage, etc.)
    const structured = { ...studentData, subjects: [] };

    // This map will help us find exams by their short code (pt, ma, hy, etc.)
    const examsByShortCode = new Map();
    config.exams.forEach(exam => {
        // Assumes exam_code is like 'periodic_test_pt', 'half_yearly_hy'. We want the last part.
        const shortCode = String(exam.exam_code).trim().split('_').pop().toLowerCase();
        if (shortCode) {
            examsByShortCode.set(shortCode, exam);
        }
    });

    // --- Main Transformation Logic ---
    for (const subject of config.subjects) {
        const subjectRow = {
            name: subject.sub_name,
            code: subject.code,
            groups: {}
        };
        const subjectCode = String(subject.code).trim();
        const subjectShortCode = getSubjectShortCode(subject); // 'sc', 'en', etc.

        for (const group of config.examGroups) {
            const groupCode = String(group.group_code).trim();
            subjectRow.groups[groupCode] = {}; // Initialize the group object, e.g., groups.t10 = {}

            // 1. Populate individual exam marks (pt, ma, po, se, hy, ae)
            const examsInGroup = config.exams.filter(ex => ex.examgroups === group._uid && ex.subjects._uid === subject._uid);

            for (const exam of examsInGroup) {
                const simpleExamCode = String(exam.exam_code).trim().split('_').pop().toLowerCase();
                if (!simpleExamCode) continue;

                // The key in studentData is constructed like: {groupCode}_{subjectCode}_{examCode}
                // Example: 't10_4_hy'
                const dataKey = `${groupCode}_${subjectCode}_${simpleExamCode}`;
                const mark = studentData[dataKey];

                if (mark !== undefined) {
                    subjectRow.groups[groupCode][simpleExamCode] = mark;
                } else {
                    subjectRow.groups[groupCode][simpleExamCode] = '-'; // Default value if not found
                    // console.warn(`Key not found: ${dataKey} for ${subject.sub_name}`);
                }
            }

            // 2. Find the total and grade for the subject within this group (e.g., Term 1 Total)
            // The API uses multiple key formats, so we check for all of them.
            const totalKeyPatterns = [
                `${groupCode}_${subjectCode}_Ob_MarksC`, // e.g., t10_4_Ob_MarksC
                `${groupCode}_${subjectShortCode}_Ob_Marks` // e.g., t1b_sc_Ob_Marks
            ];
            const gradeKeyPatterns = [
                `${groupCode}_${subjectCode}_GdC`, // e.g., t10_4_GdC
                `${groupCode}_${subjectShortCode}_Gd` // e.g., t1b_sc_Gd
            ];

            let groupTotal = '-';
            for (const key of totalKeyPatterns) {
                if (studentData[key] !== undefined) {
                    groupTotal = studentData[key];
                    break;
                }
            }

            let groupGrade = '-';
            for (const key of gradeKeyPatterns) {
                if (studentData[key] !== undefined) {
                    groupGrade = studentData[key];
                    break;
                }
            }
            subjectRow.groups[groupCode].total = groupTotal;
            subjectRow.groups[groupCode].grade = groupGrade;
        }

        // 3. Find the Grand Total and Grand Grade for the subject across all terms
        const grandTotalKeyPatterns = [
            `grand_${subjectCode}_Marks`,
            `grand_${subjectShortCode}_Marks` // e.g., grand_sc_Marks
        ];
        const grandGradeKeyPatterns = [
            `grand_${subjectCode}_gd`,
            `grand_${subjectShortCode}_gd` // e.g., grand_sc_gd
        ];

        let grandTotal = '-';
        for (const key of grandTotalKeyPatterns) {
            if (studentData[key] !== undefined) {
                grandTotal = studentData[key];
                break;
            }
        }

        let grandGrade = '-';
        for (const key of grandGradeKeyPatterns) {
            if (studentData[key] !== undefined) {
                grandGrade = studentData[key];
                break;
            }
        }
        subjectRow.grandTotal = grandTotal;
        subjectRow.grandGrade = grandGrade;

        structured.subjects.push(subjectRow);
    }

    console.log(`\n--- TRANSFORMED DATA FOR: ${studentData.full_name || 'N/A'} ---`);
    console.log(JSON.stringify(structured, null, 2));
    console.log(`---------------------------------------------------\n`);

    return structured;
}


async function GenerateOdtFile() {
    let outputDir = '';
    const jobId = process.env.JOB_ID;

    try {
        console.log("Starting dynamic marksheet generation with Carbone...");

        const groupid = process.env.GROUP_ID;
        const schoolId = process.env.SCHOOL_ID;
        const batchId = process.env.BATCH_ID;
        const courseId = process.env.COURSE_ID;
        const RANKING_ID = process.env.RANKING_ID;
        const DIVISION_ID = process.env.DIVISION_ID;
        const templateUrl = process.env.TEMPLATE_URL;
        const groupIds = groupid?.split(",");

        if (!templateUrl || !schoolId || !batchId || !jobId || !courseId || !groupIds) {
            throw new Error('Missing required environment variables from GitHub Actions inputs.');
        }

        const marksheetConfig = await fetchMarksheetConfig(groupIds);
        if (!marksheetConfig.subjects || marksheetConfig.subjects.length === 0) {
            console.warn("Warning: No subjects found for this course. Marksheets may be empty.");
        }

        outputDir = path.join(process.cwd(), 'output');
        await fs.promises.mkdir(outputDir, { recursive: true });
        const pdfPaths = [];

        const marksPayload = {
            _school: schoolId,
            batchId: [batchId],
            group: groupIds,
            "currentdata": { "division_id": DIVISION_ID, "ranking_id": RANKING_ID }
        };

        const studentResponse = await fetch('https://demoschool.edusparsh.com/api/cce_examv1/getMarks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(marksPayload),
        });
        if (!studentResponse.ok) throw new Error(`Failed to fetch student data: ${await studentResponse.text()}`);

        const studentResponseJson = await studentResponse.json();
        // Debugging: Log the raw student data to check keys
        console.log(`\n--- RAW STUDENT DATA FROM API ---`);
        console.log(JSON.stringify(studentResponseJson, null, 2));
        console.log(`--------------------------------\n`);

        const students = studentResponseJson.students || studentResponseJson.data || [];
        if (!Array.isArray(students) || students.length === 0) {
            console.warn("Warning: No students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found." });
            return;
        }
        console.log(`Generating marksheets for ${students.length} students...`);

        console.log("Downloading template from URL...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`Template saved locally to: ${templatePath}`);

        for (const student of students) {
            console.log(`Processing student: ${student.full_name}`);
            const transformedData = transformStudentDataForCarbone(student, marksheetConfig);
            const odtReport = await carboneRender(templatePath, transformedData);

            const fileSafeName = student.full_name?.replace(/\s+/g, '_') || `student_${Date.now()}`;
            const odtFilename = path.join(outputDir, `${fileSafeName}.odt`);
            await fs.promises.writeFile(odtFilename, odtReport);

            const pdfPath = await convertOdtToPdf(odtFilename, outputDir);
            pdfPaths.push(pdfPath);
        }

        const mergedPdfPath = path.join(outputDir, 'merged_output.pdf');

        if (pdfPaths.length > 0) {
            await mergePdfs(pdfPaths, mergedPdfPath);

            const filePath = `templates/marksheets/${schoolId}/result/${batchId}_${jobId}.pdf`;
            const fileBuffer = await fs.promises.readFile(mergedPdfPath);
            const formData = new FormData();

            formData.append('photo', fileBuffer, {
                filename: 'merged_output.pdf',
                contentType: 'application/pdf',
            });
            formData.append('key', filePath);
            formData.append('ContentType', 'application/pdf');
            formData.append('jobId', jobId);

            console.log(`Uploading merged PDF via API to path: ${filePath}`);
            const uploadRes = await fetch('https://demoschool.edusparsh.com/api/uploadfileToDigitalOcean', {
                method: 'POST',
                headers: formData.getHeaders(),
                body: formData,
            });

            if (!uploadRes.ok) {
                const errorData = await uploadRes.text();
                throw new Error(`File upload API failed: ${errorData || uploadRes.statusText}`);
            }

            console.log("File uploaded successfully. Updating job_history table via API...");
            await updateJobHistory(jobId, schoolId, { file_path: filePath, status: true });

            console.log('Job_history updated successfully.');
        } else {
            console.log('No PDFs were generated to merge.');
        }

        console.log("✅ Marksheets generated and uploaded successfully.");

    } catch (error) {
        console.error('❌ FATAL ERROR during marksheet generation:', error);
        if (jobId) {
            await updateJobHistory(jobId, schemaName, { status: false, notes: `Failed: ${error.message}`.substring(0, 500) });
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
            payload: payload,
        };
        const jobUpdateRes = await fetch("https://demoschool.edusparsh.com/api/updatejobHistory", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jobUpdatePayload),
        });
        if (!jobUpdateRes.ok) {
            const errorData = await jobUpdateRes.text();
            console.error(`Could not update job_history via API: ${errorData || jobUpdateRes.statusText}`);
        }
    } catch (apiError) {
        console.error("An error occurred while trying to call the updateJobHistory API.", apiError);
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