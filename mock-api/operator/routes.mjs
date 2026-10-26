import { randomUUID } from 'node:crypto';

export const isOperatorPath = (path) => /^\/api\/v1\/operator(\/|$)/.test(path);

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

const scopedContext = (db, authentication) => {
  if (authentication.role !== 'OPERATOR') fail(403, 'La operación requiere una cuenta de operario.');
  const user = db.users.find((item) => item.id === authentication.userId);
  const profile = db.operatorProfiles.find(
    (item) => item.userId === user.id && item.organizationId === authentication.organizationId,
  );
  if (!profile || profile.status !== 'ACTIVE') fail(403, 'El perfil de operario no está activo.');
  const group = db.groups.find((item) => item.id === profile.groupId);
  const assignments = db.deviceAssignments.filter(
    (item) => item.operatorProfileId === profile.id && item.status === 'ACTIVE',
  );
  const deviceIds = new Set(assignments.map((item) => item.deviceId));
  return { user, profile, group, assignments, deviceIds };
};

const requireDevice = (context, deviceId) => {
  if (!context.deviceIds.has(deviceId)) fail(403, 'El dispositivo no está asignado al operario.');
};

const allowedActions = (process) => {
  const actions = [];
  if (process.state === 'PENDING_CORRECTION_APPROVAL') actions.push('APPROVE_STRATEGY');
  if (process.state === 'READY' && process.releaseMode === 'MANUAL') actions.push('AUTHORIZE_RELEASE');
  if (!['COMPLETED', 'EMERGENCY'].includes(process.state)) actions.push('ACTIVATE_EMERGENCY');
  if (process.state === 'EMERGENCY') actions.push('RESET_EMERGENCY');
  return actions;
};

const processView = (process) => ({ ...process, allowedActions: allowedActions(process) });

export const handleOperator = ({ method, url, body, db, authentication }) => {
  const path = url.pathname;
  const context = scopedContext(db, authentication);

  if (method === 'GET' && path === '/api/v1/operator/context') {
    const members = db.operatorProfiles
      .filter((item) => item.groupId === context.group.id && item.status === 'ACTIVE')
      .map((profile) => db.users.find((user) => user.id === profile.userId))
      .filter(Boolean)
      .map((user) => ({ id: user.id, displayName: user.displayName, status: user.status }));
    return {
      status: 200,
      body: {
        profile: {
          id: context.profile.id,
          userId: context.user.id,
          displayName: context.user.displayName,
          identifier: context.user.identifier,
          email: context.user.email ?? '',
          phone: context.user.phone ?? '',
          status: context.profile.status,
        },
        group: {
          id: context.group.id,
          name: context.group.name,
          purpose: context.group.purpose ?? '',
          segment: context.group.segment ?? '',
        },
        members,
        assignments: context.assignments,
      },
    };
  }

  const configurationMatch = path.match(/^\/api\/v1\/operator\/assignments\/([^/]+)\/configuration$/);
  if (configurationMatch) {
    const assignment = context.assignments.find(
      (item) => item.id === decodeURIComponent(configurationMatch[1]),
    );
    if (!assignment) fail(403, 'La asignación no pertenece al operario.');
    const configurations = db.configurations
      .filter((item) => item.deviceId === assignment.deviceId)
      .sort((a, b) => b.configurationVersion - a.configurationVersion);
    if (method === 'GET') {
      return { status: 200, body: { assignment, configuration: configurations[0] ?? null } };
    }
    if (method === 'PUT') {
      const phMin = Number(body.phMin);
      const phMax = Number(body.phMax);
      const temperatureMin = Number(body.temperatureMin);
      const temperatureMax = Number(body.temperatureMax);
      if (![phMin, phMax, temperatureMin, temperatureMax].every(Number.isFinite))
        fail(422, 'Los cuatro límites numéricos son obligatorios.');
      if (phMin < 0 || phMax > 14 || phMin >= phMax || temperatureMin >= temperatureMax)
        fail(422, 'Los rangos de pH o temperatura no son válidos.');
      let draft = configurations.find((item) => item.status === 'DRAFT');
      const now = new Date().toISOString();
      if (!draft) {
        draft = {
          id: `cfg-${randomUUID()}`,
          organizationId: authentication.organizationId,
          deviceId: assignment.deviceId,
          configurationVersion: Math.max(0, ...configurations.map((item) => item.configurationVersion)) + 1,
          status: 'DRAFT',
          compatible: true,
          incompatibilityReasons: [],
          createdAt: now,
        };
        db.configurations.push(draft);
      }
      Object.assign(draft, {
        phMin,
        phMax,
        temperatureMin,
        temperatureMax,
        releaseMode: body.releaseMode === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL',
        correctionAction: String(body.correctionAction ?? ''),
        waitingMinutes: Number(body.waitingMinutes ?? 10),
        maximumCycles: Number(body.maximumCycles ?? 3),
        updatedAt: now,
      });
      return { status: 200, body: draft, changed: true };
    }
  }

  const publishMatch = path.match(/^\/api\/v1\/operator\/assignments\/([^/]+)\/configuration\/publish$/);
  if (method === 'POST' && publishMatch) {
    const assignment = context.assignments.find((item) => item.id === decodeURIComponent(publishMatch[1]));
    if (!assignment) fail(403, 'La asignación no pertenece al operario.');
    const draft = db.configurations
      .filter((item) => item.deviceId === assignment.deviceId && item.status === 'DRAFT')
      .sort((a, b) => b.configurationVersion - a.configurationVersion)[0];
    if (!draft) fail(409, 'No existe un borrador para publicar.');
    db.configurations
      .filter((item) => item.deviceId === assignment.deviceId && item.status === 'PUBLISHED')
      .forEach((item) => { item.status = 'SUPERSEDED'; });
    draft.status = 'PUBLISHED';
    draft.publishedAt = new Date().toISOString();
    return { status: 200, body: draft, changed: true };
  }

  const telemetryMatch = path.match(/^\/api\/v1\/operator\/devices\/([^/]+)\/telemetry$/);
  if (method === 'GET' && telemetryMatch) {
    const deviceId = decodeURIComponent(telemetryMatch[1]);
    requireDevice(context, deviceId);
    const device = db.devices.find((item) => item.id === deviceId);
    const measurements = db.measurements
      .filter((item) => item.deviceId === deviceId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
    return { status: 200, body: { device, latest: measurements[0] ?? null, history: measurements.slice(0, 20) } };
  }

  if (method === 'GET' && path === '/api/v1/operator/treatments') {
    return {
      status: 200,
      body: db.treatmentProcesses
        .filter((item) => context.deviceIds.has(item.deviceId))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map(processView),
    };
  }

  const commandMatch = path.match(/^\/api\/v1\/operator\/treatments\/([^/]+)\/commands$/);
  if (method === 'POST' && commandMatch) {
    const process = db.treatmentProcesses.find((item) => item.id === decodeURIComponent(commandMatch[1]));
    if (!process) fail(404, 'Proceso no encontrado.');
    requireDevice(context, process.deviceId);
    const command = String(body.command ?? '');
    if (!allowedActions(process).includes(command)) fail(409, 'La acción no está permitida en el estado actual.');
    const now = new Date().toISOString();
    if (command === 'APPROVE_STRATEGY') {
      process.state = 'CORRECTING';
      process.approvalStatus = 'APPROVED';
    } else if (command === 'AUTHORIZE_RELEASE') {
      process.state = 'COMPLETED';
      process.releaseEligibility = 'AUTHORIZED';
      process.completedAt = now;
    } else if (command === 'ACTIVATE_EMERGENCY') {
      process.state = 'EMERGENCY';
      process.emergencyReason = String(body.reason ?? 'Emergencia activada por el operario.');
    } else if (command === 'RESET_EMERGENCY') {
      process.state = 'READING';
      process.emergencyReason = null;
    }
    process.updatedAt = now;
    process.events ||= [];
    process.events.push({
      id: `tev-${randomUUID()}`,
      title: command,
      description: `Acción ${command} ejecutada por ${context.user.displayName}.`,
      outcome: command === 'ACTIVATE_EMERGENCY' ? 'WARNING' : 'INFO',
      occurredAt: now,
    });
    return { status: 200, body: processView(process), changed: true };
  }

  if (method === 'GET' && path === '/api/v1/operator/alerts') {
    return {
      status: 200,
      body: db.alerts
        .filter((item) => context.deviceIds.has(item.deviceId))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    };
  }

  const acknowledgeMatch = path.match(/^\/api\/v1\/operator\/alerts\/([^/]+)\/acknowledge$/);
  if (method === 'PATCH' && acknowledgeMatch) {
    const alert = db.alerts.find((item) => item.id === decodeURIComponent(acknowledgeMatch[1]));
    if (!alert) fail(404, 'Alerta no encontrada.');
    requireDevice(context, alert.deviceId);
    if (alert.status !== 'ACTIVE') fail(409, 'La alerta ya fue atendida.');
    alert.status = 'ACKNOWLEDGED';
    alert.attendedAt = new Date().toISOString();
    alert.updatedAt = alert.attendedAt;
    return { status: 200, body: alert, changed: true };
  }

  const historyMatch = path.match(/^\/api\/v1\/operator\/devices\/([^/]+)\/history$/);
  if (method === 'GET' && historyMatch) {
    const deviceId = decodeURIComponent(historyMatch[1]);
    requireDevice(context, deviceId);
    const events = db.traceabilityEntries
      .filter((item) => item.deviceId === deviceId)
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const reports = (db.reports ?? []).filter((item) => item.deviceId === deviceId);
    return { status: 200, body: { events, reports } };
  }

  return { status: 404, body: { message: 'Endpoint de operario no encontrado.' } };
};
