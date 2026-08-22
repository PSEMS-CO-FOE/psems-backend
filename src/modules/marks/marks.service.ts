import {
  CriterionLevel,
  MarkCounting,
  PanelRole,
  RubricScoreStatus,
  SessionStatus,
  StagePanelRule,
} from "@prisma/client";
import { prisma } from "../../config/database";
import { AuthError } from "../auth/auth.service";
import { loadOwnedCpi } from "../courses/courses.service";
import { effectiveMarkCounting } from "../panel/panel.service";
import { getStudentGroupId, loadPolicy } from "../shared/cpiMembership";
import { gradeFor, listGradeBands } from "./grades.service";
import { resolveVisibility } from "./publication.service";

type ScoredPanelist = { id: string; role: PanelRole; markCounting: MarkCounting | null; weightPercent: number | null };
type Rules = Pick<StagePanelRule, "role" | "weightPercent" | "markCounting">[];

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

// A seat's own weight wins over its role's, so a coordinator can weight three
// plain evaluators 50/25/25 without needing separate senior/junior roles.
function resolveWeight(panelist: ScoredPanelist, rules: Rules): number | null {
  return panelist.weightPercent ?? rules.find((r) => r.role === panelist.role)?.weightPercent ?? null;
}

// Combine one criterion's scores into a single value.
//
// This is a weighted MEAN — sum(score x weight) / sum(weight) — not a sum of
// weighted scores. Weights say how much someone's opinion counts, so three
// markers weighted 50/25/25 who all give 80 must produce 80, not 40.
//
// With no weights set anywhere it becomes a plain average, which is the usual
// case. A seat left unweighted among weighted ones counts as an average seat
// rather than dropping out.
function combineScores(scores: { score: number; panelist: ScoredPanelist }[], rules: Rules) {
  if (scores.length === 0) return 0;

  const entries = scores.map((s) => ({ score: s.score, weight: resolveWeight(s.panelist, rules) }));
  const specified = entries.map((e) => e.weight).filter((w): w is number => w !== null);
  if (specified.length === 0) return mean(entries.map((e) => e.score));

  const fallback = mean(specified);
  const totalWeight = entries.reduce((sum, e) => sum + (e.weight ?? fallback), 0);
  if (totalWeight === 0) return mean(entries.map((e) => e.score));

  return entries.reduce((sum, e) => sum + e.score * (e.weight ?? fallback), 0) / totalWeight;
}

// Which seats fall in the pooled group, capped at the stage's scorer limit.
// Sorted by seat id so the same people are picked every time marks are worked
// out — running aggregation again must not change anyone's result.
function orderedPooledPanelistIds(
  scores: { sessionPanelistId: string; panelist: ScoredPanelist }[],
  rules: Pick<StagePanelRule, "role" | "markCounting">[],
  limit: number | null,
) {
  const ids = [
    ...new Set(
      scores
        .filter((s) => effectiveMarkCounting(s.panelist, rules) === MarkCounting.COORDINATOR_DECIDES)
        .map((s) => s.sessionPanelistId),
    ),
  ].sort();
  return new Set(limit === null ? ids : ids.slice(0, limit));
}

// Work out each group's and each student's marks from finalized scores.
// Every session has to be approved at review first.
//
// Per criterion: combine the panel's scores, turn that into a percentage of the
// criterion's maximum, then weight it by the criterion's weight to get its share
// of the stage. GROUP criteria give every member the same share; INDIVIDUAL
// criteria give each member their own. The stage total is then weighted by the
// stage's weight to get its share of the course.
export async function aggregateMarks(coordinatorUserId: string, cpiId: string) {
  await loadOwnedCpi(coordinatorUserId, cpiId);

  const sessions = await prisma.evaluationSession.findMany({
    where: { courseInstanceId: cpiId },
    include: { stage: { include: { criteria: true, panelRules: true } } },
  });
  if (sessions.length === 0) throw new AuthError(409, "No evaluation sessions to aggregate");
  if (sessions.some((s) => s.status !== SessionStatus.FINALIZED)) {
    throw new AuthError(409, "Every session must be approved at review before aggregation");
  }

  for (const session of sessions) {
    const scores = await prisma.rubricScore.findMany({
      where: { evaluationSessionId: session.id, status: RubricScoreStatus.FINALIZED },
      include: { panelist: { select: { id: true, role: true, markCounting: true, weightPercent: true } } },
    });

    const rules = session.stage.panelRules;
    // ADVISORY marks are recorded and shown but never reach the total.
    const contributing = scores.filter((s) => effectiveMarkCounting(s.panelist, rules) !== MarkCounting.ADVISORY);

    // Walk-ins and guests without a formal role are pooled: averaged into ONE
    // contribution weighted by the stage's pooled share, so a crowd cannot
    // outvote the formal panel by sheer number. The scorer limit caps how many
    // of them count and is held the same across the stage, so panels of
    // different sizes stay comparable.
    const pooledIds = orderedPooledPanelistIds(contributing, rules, session.stage.pooledScorerLimit);
    const pooledShare = (session.stage.pooledSharePercent ?? 0) / 100;

    // One criterion's share of the stage, for the group or for one student.
    // Null when nobody scored it, which the callers treat as zero: the mark
    // then shows the shortfall instead of hiding it. Re-sharing the missing
    // weight across the scored criteria would quietly award a mark for work
    // nobody assessed. The reviewer is told how many panelists have finished
    // before they close scoring, so this only happens when they close short.
    const contributionFor = (criterionId: string, maxScore: number, weight: number, studentId?: string) => {
      const forCriterion = contributing.filter(
        (s) => s.rubricCriterionId === criterionId && (studentId === undefined || s.studentId === studentId),
      );
      if (forCriterion.length === 0) return null;

      const pooled = forCriterion.filter((s) => pooledIds.has(s.sessionPanelistId));
      const formal = forCriterion.filter((s) => !pooledIds.has(s.sessionPanelistId));

      const formalAvg = combineScores(formal, rules);
      // The pool is deliberately a flat average — the whole point is that a
      // crowd speaks with one voice, not many.
      const pooledAvg = mean(pooled.map((s) => s.score));

      const share = pooled.length > 0 ? pooledShare : 0;
      const value = formal.length > 0 ? formalAvg * (1 - share) + pooledAvg * share : pooledAvg;

      return (value / maxScore) * 100 * (weight / 100);
    };

    const groupCriteria = session.stage.criteria.filter((c) => c.level === CriterionLevel.GROUP);
    const individualCriteria = session.stage.criteria.filter((c) => c.level === CriterionLevel.INDIVIDUAL);

    const groupComponent = groupCriteria.reduce(
      (sum, c) => sum + (contributionFor(c.id, c.maxScore, c.weight) ?? 0),
      0,
    );

    const members = await prisma.groupMember.findMany({
      where: { groupId: session.groupId, status: "ACCEPTED" },
      select: { studentId: true },
    });

    const studentTotals: number[] = [];
    for (const { studentId } of members) {
      const individualComponent = individualCriteria.length
        ? individualCriteria.reduce((sum, c) => sum + (contributionFor(c.id, c.maxScore, c.weight, studentId) ?? 0), 0)
        : null;

      const stagePct = groupComponent + (individualComponent ?? 0);
      studentTotals.push(stagePct);

      await prisma.studentMark.upsert({
        where: { studentId_evaluationStageId: { studentId, evaluationStageId: session.evaluationStageId } },
        update: {
          groupComponentPercent: groupComponent,
          individualComponentPercent: individualComponent,
          stageScorePercent: stagePct,
          weightedContribution: stagePct * (session.stage.weight / 100),
        },
        create: {
          courseInstanceId: cpiId,
          studentId,
          groupId: session.groupId,
          evaluationStageId: session.evaluationStageId,
          groupComponentPercent: groupComponent,
          individualComponentPercent: individualComponent,
          stageScorePercent: stagePct,
          weightedContribution: stagePct * (session.stage.weight / 100),
        },
      });
    }

    // The group's own figure is the average of its members'. With only GROUP
    // criteria every member scores the same, so this matches what the group
    // mark has always been.
    const stagePct = studentTotals.length
      ? mean(studentTotals)
      : groupComponent + individualCriteria.reduce((sum, c) => sum + (contributionFor(c.id, c.maxScore, c.weight) ?? 0), 0);

    await prisma.finalMark.upsert({
      where: { groupId_evaluationStageId: { groupId: session.groupId, evaluationStageId: session.evaluationStageId } },
      update: { stageScorePercent: stagePct, weightedContribution: stagePct * (session.stage.weight / 100) },
      create: {
        courseInstanceId: cpiId,
        groupId: session.groupId,
        evaluationStageId: session.evaluationStageId,
        stageScorePercent: stagePct,
        weightedContribution: stagePct * (session.stage.weight / 100),
      },
    });
  }

  return getMarks(coordinatorUserId, cpiId);
}

interface StageBreakdown {
  stageId: string;
  stageName: string;
  weight: number;
  stageScorePercent: number;
  weightedContribution: number;
}

interface StudentBreakdown extends StageBreakdown {
  // Null when the stage has no INDIVIDUAL criteria, so every member of the group
  // scored the same.
  groupComponentPercent: number;
  individualComponentPercent: number | null;
}

interface StudentRow {
  studentId: string;
  indexNumber: string;
  name: string;
  stages: StudentBreakdown[];
  overall: number;
  grade: string | null;
}

interface GroupRow {
  groupId: string;
  groupName: string;
  stages: StageBreakdown[];
  overall: number;
  grade: string | null;
  contributionToModule?: number | null;
  students: Map<string, StudentRow>;
}

export async function getMarks(userId: string, cpiId: string) {
  const cpi = await prisma.courseInstance.findUnique({ where: { id: cpiId } });
  if (!cpi) throw new AuthError(404, "CPI not found");

  if (cpi.createdById === userId) {
    await loadOwnedCpi(userId, cpiId);
    return buildMarksView(cpiId, { coordinator: true });
  }

  const groupId = await getStudentGroupId(userId, cpiId);
  if (!groupId) throw new AuthError(403, "You are not a participant in this CPI");

  const student = await prisma.student.findUnique({ where: { userId }, select: { id: true } });
  return buildMarksView(cpiId, { coordinator: false, groupId, studentId: student?.id });
}

interface ViewOptions {
  coordinator: boolean;
  groupId?: string;
  studentId?: string;
}

// The coordinator sees every group and every student. A student sees their own
// group, and only the stages that have been published — a stage still being
// marked simply does not appear.
async function buildMarksView(cpiId: string, opts: ViewOptions) {
  const [policy, bands, visibilityFor, stages] = await Promise.all([
    loadPolicy(cpiId),
    listGradeBands(cpiId),
    resolveVisibility(cpiId),
    prisma.evaluationStage.findMany({
      where: { courseInstanceId: cpiId },
      orderBy: { orderIndex: "asc" },
      select: { id: true, name: true, weight: true },
    }),
  ]);

  const visibleStageIds = opts.coordinator
    ? stages.map((s) => s.id)
    : stages.filter((s) => visibilityFor(s.id).marks).map((s) => s.id);

  const [groupMarks, studentMarks] = await Promise.all([
    prisma.finalMark.findMany({
      where: {
        courseInstanceId: cpiId,
        evaluationStageId: { in: visibleStageIds },
        ...(opts.groupId ? { groupId: opts.groupId } : {}),
      },
      include: { group: { select: { id: true, name: true } } },
    }),
    prisma.studentMark.findMany({
      where: {
        courseInstanceId: cpiId,
        evaluationStageId: { in: visibleStageIds },
        ...(opts.groupId ? { groupId: opts.groupId } : {}),
      },
      include: {
        student: { select: { id: true, studentId: true, user: { select: { fullName: true, email: true } } } },
      },
    }),
  ]);

  const stageById = new Map(stages.map((s) => [s.id, s]));

  const byGroup = new Map<string, GroupRow>();

  for (const mark of groupMarks) {
    const stage = stageById.get(mark.evaluationStageId)!;
    const entry: GroupRow = byGroup.get(mark.groupId) ?? {
      groupId: mark.groupId,
      groupName: mark.group.name,
      stages: [],
      overall: 0,
      grade: null,
      students: new Map(),
    };
    entry.stages.push({
      stageId: stage.id,
      stageName: stage.name,
      weight: stage.weight,
      stageScorePercent: round2(mark.stageScorePercent),
      weightedContribution: round2(mark.weightedContribution),
    });
    entry.overall = round2(entry.overall + mark.weightedContribution);
    byGroup.set(mark.groupId, entry);
  }

  for (const mark of studentMarks) {
    const group = byGroup.get(mark.groupId);
    if (!group) continue;
    // A student only sees their own breakdown; their group-mates' individual
    // marks are none of their business.
    if (!opts.coordinator && opts.studentId && mark.studentId !== opts.studentId) continue;

    const stage = stageById.get(mark.evaluationStageId)!;
    const entry: StudentRow = group.students.get(mark.studentId) ?? {
      studentId: mark.studentId,
      indexNumber: mark.student.studentId,
      name: mark.student.user.fullName || mark.student.user.email,
      stages: [],
      overall: 0,
      grade: null,
    };
    entry.stages.push({
      stageId: stage.id,
      stageName: stage.name,
      weight: stage.weight,
      groupComponentPercent: round2(mark.groupComponentPercent),
      individualComponentPercent:
        mark.individualComponentPercent === null ? null : round2(mark.individualComponentPercent),
      stageScorePercent: round2(mark.stageScorePercent),
      weightedContribution: round2(mark.weightedContribution),
    });
    entry.overall = round2(entry.overall + mark.weightedContribution);
    group.students.set(mark.studentId, entry);
  }

  // A grade is only meaningful when this assessment IS the module. Where it is
  // one component of a larger module, the letter for the module cannot be worked
  // out from these marks alone — the rest of it lives outside PSEMS — so the
  // contribution is reported instead of a grade that would be wrong.
  const isWholeModule = policy.caContributionPercent === null || policy.caContributionPercent >= 100;
  // The coordinator always sees the grade; a student only once it is released,
  // which is a separate decision from releasing the marks.
  const gradesReleased = opts.coordinator || stages.every((st) => visibilityFor(st.id).grades);
  const showGrade = policy.gradingEnabled && isWholeModule && gradesReleased;

  // What these marks add to the module, e.g. 80 out of 100 at a 40% weighting
  // contributes 32 marks.
  const contributionOf = (overall: number) =>
    policy.caContributionPercent === null ? null : round2((overall * policy.caContributionPercent) / 100);

  const groups = [...byGroup.values()].map((group) => ({
    ...group,
    grade: showGrade ? gradeFor(group.overall, bands) : null,
    contributionToModule: contributionOf(group.overall),
    students: [...group.students.values()].map((student) => ({
      ...student,
      grade: showGrade ? gradeFor(student.overall, bands) : null,
      contributionToModule: contributionOf(student.overall),
    })),
  }));

  return {
    gradingEnabled: policy.gradingEnabled,
    caContributionPercent: policy.caContributionPercent,
    // False when this assessment is only part of a module: the marks still
    // count, but the module's letter grade is decided elsewhere.
    gradeIsForWholeModule: isWholeModule,
    gradesReleased,
    // Marks are only part of the picture when they are shown per stage, so the
    // stages a student cannot see yet are named as pending rather than hidden.
    pendingStages: opts.coordinator
      ? []
      : stages.filter((s) => !visibilityFor(s.id).marks).map((s) => ({ stageId: s.id, stageName: s.name })),
    groups,
  };
}

export interface SheetRow {
  indexNumber: string;
  registrationNumber: string | null;
  surname: string;
  initials: string;
  name: string;
  groupName: string;
  stagePercents: Record<string, number | null>;
  total: number;
  grade: string | null;
  zeroTotal: boolean;
  belowPassMark: boolean;
}

// Mark sheets carry a surname and initials in separate columns. Names are stored
// as one field, so the last word is taken as the surname and the rest become
// initials. Good enough for the sheet, and the full name is sent as well so the
// coordinator can correct anything odd.
function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { surname: "", initials: "" };
  const surname = parts[parts.length - 1];
  const initials = parts
    .slice(0, -1)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join("");
  return { surname, initials };
}

// The CA sheet: one row per student, one column per stage, plus the weight row
// and total the department's own sheet carries. Coordinator only.
export async function getMarkSheet(coordinatorUserId: string, cpiId: string) {
  const cpi = await loadOwnedCpi(coordinatorUserId, cpiId);

  const [policy, bands, stages, marks] = await Promise.all([
    loadPolicy(cpiId),
    listGradeBands(cpiId),
    prisma.evaluationStage.findMany({
      where: { courseInstanceId: cpiId },
      orderBy: { orderIndex: "asc" },
      select: { id: true, name: true, weight: true },
    }),
    prisma.studentMark.findMany({
      where: { courseInstanceId: cpiId },
      include: {
        group: { select: { name: true } },
        student: {
          select: {
            id: true,
            studentId: true,
            registrationNumber: true,
            user: { select: { fullName: true, email: true } },
          },
        },
      },
    }),
  ]);

  const byStudent = new Map<string, SheetRow>();
  for (const mark of marks) {
    const fullName = mark.student.user.fullName || mark.student.user.email;
    const row =
      byStudent.get(mark.studentId) ??
      ({
        indexNumber: mark.student.studentId,
        registrationNumber: mark.student.registrationNumber,
        ...splitName(fullName),
        name: fullName,
        groupName: mark.group.name,
        stagePercents: Object.fromEntries(stages.map((s) => [s.id, null])),
        total: 0,
        grade: null,
        zeroTotal: false,
        belowPassMark: false,
      } as SheetRow);

    row.stagePercents[mark.evaluationStageId] = round2(mark.stageScorePercent);
    row.total = round2(row.total + mark.weightedContribution);
    byStudent.set(mark.studentId, row);
  }

  // The sheet is the coordinator's own working document, so it does not wait on
  // release — but a grade is still only meaningful when this assessment IS the
  // module. Where it is one component, the module's letter is decided elsewhere.
  const sheetShowsGrade =
    policy.gradingEnabled && (policy.caContributionPercent === null || policy.caContributionPercent >= 100);

  const rows = [...byStudent.values()]
    .map((row) => ({
      ...row,
      grade: sheetShowsGrade ? gradeFor(row.total, bands) : null,
      // Flagged rather than dropped: a zero total usually means a student was
      // never scored, which the coordinator needs to see before submitting.
      zeroTotal: row.total === 0,
      // Who the coordinator needs to look at. Never sent to the student — being
      // repeated is the department's decision to make and to communicate.
      belowPassMark: policy.passMarkPercent !== null && row.total < policy.passMarkPercent,
    }))
    .sort((a, b) => a.indexNumber.localeCompare(b.indexNumber));

  return {
    courseName: cpi.name,
    academicYear: cpi.academicYear,
    gradingEnabled: policy.gradingEnabled,
    passMarkPercent: policy.passMarkPercent,
    gradeIsForWholeModule: sheetShowsGrade || !policy.gradingEnabled,
    caContributionPercent: policy.caContributionPercent,
    stages,
    // The weight row the printed sheet carries, as fractions summing to 1.00.
    weights: Object.fromEntries(stages.map((s) => [s.id, round2(s.weight / 100)])),
    rows,
    flagged: rows.filter((r) => r.zeroTotal).length,
    belowPassMark: rows.filter((r) => r.belowPassMark).length,
  };
}
