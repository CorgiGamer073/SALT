(function(root) {
    'use strict';

    function create({ button, report, source, getDraft, request }) {
        let sequence = 0;
        let pending = false;

        function invalidate() {
            sequence++;
            pending = false;
            report.textContent = '';
            report.hidden = true;
            button.disabled = !getDraft();
            describeSource(getDraft());
        }
        function describeSource(draft) {
            source.textContent = draft
                ? `Source: local working copy → submitted browser draft. Local modified time: ${draft.source?.modifiedAt || 'unknown'}. Provider freshness: unknown; use explicit Sync Files to refresh. Loaded SHA-256: ${draft.loadedHash || 'unknown'}.`
                : 'Select a synchronized XML or JSON file. Inspection never saves, uploads, or restarts the server.';
        }

        async function inspect() {
            const draft = getDraft();
            if (!draft || pending) return;
            const requestId = ++sequence;
            const isCurrent = () => {
                const current = getDraft();
                return requestId === sequence && current?.contextVersion === draft.contextVersion &&
                    current?.fileName === draft.fileName && current?.content === draft.content;
            };
            const fileType = draft.fileName.split('.').pop().toLowerCase();
            if (!['xml', 'json'].includes(fileType)) return;
            pending = true;
            button.disabled = true;
            report.hidden = false;
            report.textContent = 'Inspecting browser draft…';
            describeSource(draft);
            try {
                const response = await request(`/api/validate/${fileType}`, {
                    method: 'POST',
                    body: JSON.stringify({ fileName: draft.fileName, content: draft.content, documentType: draft.documentType }),
                });
                if (!isCurrent()) return;
                const data = await response.json();
                if (!isCurrent()) return;
                if (!response.ok || !data.success) throw new Error(data.error || 'Inspection failed');
                const result = data.validation;
                const lines = [
                    'Mission Doctor Lite — report-only',
                    `File: ${draft.fileName}`,
                    `Draft SHA-256: ${result.sha256 || 'unavailable'}`,
                    `Rule coverage: ${result.supportLevel || 'syntax only / unspecified'}`,
                    result.valid ? 'No errors found by the supported checks.' : 'Errors found in this draft.',
                    'This is not complete schema, cross-file dependency, provider, or runtime verification.',
                ];
                for (const [name, items] of [['ERROR', result.errors], ['WARNING', result.warnings], ['INFO', result.info]]) {
                    for (const item of (items || [])) {
                        lines.push(`${name}${item.line ? ` line ${item.line}` : ''} [${item.code || name}]: ${item.message}`);
                    }
                }
                if (Object.values(result.truncation || {}).some(item => item.truncated)) lines.push('Diagnostic output was truncated; fix reported issues and inspect again.');
                report.textContent = lines.join('\n');
            } catch (error) {
                if (!isCurrent()) return;
                report.textContent = `Inspection failed: ${error.message}`;
            } finally {
                if (requestId === sequence) {
                    pending = false;
                    button.disabled = !getDraft();
                }
            }
        }

        button.addEventListener('click', inspect);
        describeSource(getDraft());
        return { inspect, invalidate };
    }

    root.MissionDoctor = { create };
}(globalThis));
