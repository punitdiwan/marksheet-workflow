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

async function fetchMarksheetConfig(groupIds, batchId) {
    console.log(`Fetching config for groups: ${groupIds}`);
    if (!batchId) {
        throw new Error("batchId is required to fetch marksheet config, but was not provided.");
    }

    const { data: examGroups, error: groupsError } = await supabase
        .from('exam_groups')
        .select('_uid, group_code, name')
        .in('_uid', groupIds);
    if (groupsError) throw new Error(`Error fetching exam groups: ${groupsError.message}`);

    const { data: exams, error: examsError } = await supabase
        .from('cce_exams')
        .select('exam_code, name, examgroups, maximum_marks, minimum_marks, subjects!inner(_uid, sub_name, code, is_coscholastic_sub)')
        .in('examgroups', groupIds)
        .eq('subjects.is_coscholastic_sub', false);
    if (examsError) throw new Error(`Error fetching exams: ${examsError.message}`);

    const subjectsMap = new Map();
    exams.forEach(exam => {
        if (exam.subjects && !subjectsMap.has(exam.subjects._uid)) {
            subjectsMap.set(exam.subjects._uid, exam.subjects);
        }
    });
    const scholasticSubjects = Array.from(subjectsMap.values());

    console.log(`Fetching co-scholastic subjects for batch ID: ${batchId}...`);
    const { data: coScholasticSubjects, error: coScholasticError } = await supabase
        .from('subjects')
        .select('_uid, sub_name, code')
        .eq('is_coscholastic_sub', true)
        .eq('batches', [batchId]);

    if (coScholasticError) {
        console.warn(`Warning: Could not fetch co-scholastic subjects. They will be skipped. Error: ${coScholasticError.message}`);
    }

    console.log(`Found ${scholasticSubjects.length} unique scholastic subjects and ${exams.length} exams.`);
    return { examGroups, exams, subjects: scholasticSubjects, coScholasticSubjects: coScholasticSubjects || [] };
}

async function fetchCoScholasticGrades(studentIds, groupIds) {
    if (!studentIds || studentIds.length === 0) return {};
    console.log(`Fetching co-scholastic grades for ${studentIds.length} students...`);

    const { data, error } = await supabase
        .from('coscholastic_sub_grade')
        .select('grade, subjectid, studentid,exam_groups')
        .in('studentid', studentIds)
        .in('exam_groups', groupIds);

    if (error) {
        throw new Error(`Error fetching co-scholastic grades: ${error.message}`);
    }

    const gradesByStudent = {};
    for (const record of data) {
        if (!gradesByStudent[record.studentid]) {
            gradesByStudent[record.studentid] = [];
        }
        gradesByStudent[record.studentid].push(record);
    }

    console.log(`Found co-scholastic grades for ${Object.keys(gradesByStudent).length} students.`);
    return gradesByStudent;
}

function transformStudentDataForCarbone(studentData, config, studentCoScholasticGrades) {
    const structured = { ...studentData, scholasticSubjects: [], coScholasticSubjects: [] };
    const grandTotals = {};

    for (const subject of config.subjects) {
        const subjectRow = { name: subject.sub_name, groups: {} };

        for (const group of config.examGroups) {
            const groupCode = String(group.group_code).trim();
            subjectRow.groups[groupCode] = {};

            const examsInGroup = config.exams.filter(ex => ex.examgroups === group._uid && ex.subjects._uid === subject._uid);

            for (const exam of examsInGroup) {
                const compositeExamCode = String(exam.exam_code).trim();

                const dataKey = `${groupCode}_${compositeExamCode}`;

                const mark = studentData[dataKey] || '-';

                const simpleExamCode = compositeExamCode.split('_').pop();

                subjectRow.groups[groupCode][simpleExamCode] = mark;

                subjectRow.groups[groupCode][`${simpleExamCode}_max`] = exam.maximum_marks ?? '-';
                subjectRow.groups[groupCode][`${simpleExamCode}_min`] = exam.minimum_marks ?? '-';

                const totalKey = `${dataKey}_total`;

                let numericMark = Number(mark);
                if (isNaN(numericMark)) {
                    numericMark = 0;
                }

                grandTotals[totalKey] = (grandTotals[totalKey] || 0) + numericMark;
            }

            const totalMarksKey = `${groupCode}_${String(subject.code).trim()}_Ob_MarksC`;
            const gradeKey = `${groupCode}_${String(subject.code).trim()}_GdC`;

            subjectRow.groups[groupCode].total = studentData[totalMarksKey] || '-';
            subjectRow.groups[groupCode].grade = studentData[gradeKey] || '-';
        }

        const subjectGrandTotal = Object.values(subjectRow.groups).reduce((sum, group) => sum + (Number(group.total) || 0), 0);
        const grandGradeKey = `grand_${String(subject.code).trim()}_gd`;
        subjectRow.grandTotal = subjectGrandTotal;
        subjectRow.grandGrade = studentData[grandGradeKey] || '-';
        structured.scholasticSubjects.push(subjectRow);
    }

    if (config.coScholasticSubjects?.length > 0) {
        for (const coSub of config.coScholasticSubjects) {
            const subjectRow = {
                name: coSub.sub_name,
                groups: {}
            };

            for (const group of config.examGroups) {
                const groupCode = String(group.group_code).trim();
                const groupId = group._uid;

                const gradeRecord = studentCoScholasticGrades.find(
                    g => g.subjectid === coSub._uid && g.exam_groups === groupId
                );

                subjectRow.groups[groupCode] = {
                    grade: gradeRecord ? (gradeRecord.grade || '-') : '-',
                };
            }

            structured.coScholasticSubjects.push(subjectRow);
        }
    }

    Object.assign(structured, grandTotals);
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

        const marksheetConfig = await fetchMarksheetConfig(groupIds, batchId);

        if (!marksheetConfig.subjects || marksheetConfig.subjects.length === 0) {
            console.warn("Warning: No scholastic subjects found for this course.");
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
        const students = studentResponseJson.students || studentResponseJson.data || [];

        if (!Array.isArray(students) || students.length === 0) {
            console.warn("Warning: No students found. Exiting gracefully.");
            await updateJobHistory(jobId, schoolId, { status: true, notes: "Completed: No students found." });
            return;
        }
        console.log(`Generating marksheets for ${students.length} students...`);

        const studentIds = students.map(s => s.student_id);
        const allCoScholasticGrades = await fetchCoScholasticGrades(studentIds, groupIds);

        console.log("Downloading template from URL...");
        const templateBuffer = await downloadFile(templateUrl);
        const templatePath = path.join(outputDir, 'template.odt');
        await fs.promises.writeFile(templatePath, templateBuffer);
        console.log(`Template saved locally to: ${templatePath}`);

        let hasLoggedFirstStudent = false;

        for (const student of students) {
            console.log(`Processing student: ${student.full_name}`);

            const studentCoScholasticGrades = allCoScholasticGrades[student.student_id] || [];

            const transformedData = transformStudentDataForCarbone(student, marksheetConfig, studentCoScholasticGrades);


            if (!hasLoggedFirstStudent) {
                console.log(`\n\n--- DEBUG: TRANSFORMED DATA FOR FIRST STUDENT (${student.full_name || 'N/A'}) ---`);
                console.log(JSON.stringify(transformedData, null, 2));
                console.log(`---------------------------------------------------------------------\n\n`);
                hasLoggedFirstStudent = true;
            }

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
                contentType: 'application/pdf'
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
            payload: payload
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