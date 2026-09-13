const express = require('express');
const router = express.Router();
const validationService = require('../services/validationService');
const { ensureAuthenticated } = require('../middleware/auth');
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function checkDraft(req, res) {
  const { fileName, content, documentType } = req.body || {};
  if (typeof fileName !== 'string' || !fileName || fileName.length > 512 ||
      typeof content !== 'string' ||
      (documentType !== undefined && (typeof documentType !== 'string' || documentType.length > 64))) {
    res.status(400).json({ success: false, error: 'A file name and string content are required' });
    return false;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    res.status(413).json({ success: false, error: 'Draft exceeds the 5 MiB inspection limit' });
    return false;
  }
  return true;
}

// Validate file content
router.post('/validate/:fileType', ensureAuthenticated, async (req, res) => {
  if (!checkDraft(req, res)) return;
  const { fileType } = req.params;
  const { fileName, content, documentType } = req.body;

  if (!content) {
    return res.status(400).json({ success: false, error: 'Content required' });
  }

  try {
    let result;

    if (fileType === 'xml') {
      result = await validationService.validateXML(fileName, content, documentType);
    } else if (fileType === 'json') {
      result = validationService.validateJSON(fileName, content);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid file type' });
    }

    const summary = validationService.getValidationSummary(result);

    res.json({
      success: true,
      source: 'submitted_draft',
      reportOnly: true,
      providerVerified: false,
      validation: result,
      summary
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lint and auto-fix
router.post('/lint/:fileType', async (req, res) => {
  const { fileType } = req.params;
  const { fileName, content } = req.body;

  if (!content) {
    return res.status(400).json({ success: false, error: 'Content required' });
  }

  try {
    const result = await validationService.lintAndFix(fileName, content, fileType);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;