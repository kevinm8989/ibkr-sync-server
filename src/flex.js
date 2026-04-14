/**
 * IBKR Flex Web Service
 *
 * Flow:
 *  1. POST request to send-request URL with token + queryId  → get a reference code
 *  2. Poll the receive-data URL with that reference code     → get the XML/CSV report
 *
 * Docs: https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service_version_3.htm
 */

const FLEX_BASE = 'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService';

/**
 * @param {string} token      - Your Flex Query token (from IBKR Account Management)
 * @param {string} queryId    - The Flex Query ID you created
 * @returns {string}          - Raw report text (XML or CSV depending on query config)
 */
export async function fetchFlexReport(token, queryId) {
  // Step 1: Request the report
  const sendUrl = `${FLEX_BASE}.SendRequest?t=${token}&q=${queryId}&v=3`;
  const sendRes = await fetch(sendUrl);
  const sendText = await sendRes.text();

  // Extract reference code from XML response
  const refMatch = sendText.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/);
  if (!refMatch) {
    // Check for error message
    const errMatch = sendText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
    throw new Error(errMatch ? `IBKR error: ${errMatch[1]}` : `Unexpected IBKR response: ${sendText.slice(0, 200)}`);
  }
  const refCode = refMatch[1];
  console.log(`[flex] Got reference code: ${refCode}`);

  // Step 2: Poll for the report (IBKR says wait at least 5s before first poll)
  const getUrl = `${FLEX_BASE}.GetStatement?q=${refCode}&t=${token}&v=3`;
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(attempt === 1 ? 6000 : 3000); // First wait 6s, then 3s between retries
    console.log(`[flex] Poll attempt ${attempt}/${maxAttempts}...`);

    const getRes = await fetch(getUrl);
    const getText = await getRes.text();

    // If still pending, IBKR returns a status XML
    if (getText.includes('<Status>Processing</Status>') || getText.includes('Statement generation in progress')) {
      console.log('[flex] Still processing...');
      continue;
    }

    // Error check
    if (getText.includes('<ErrorCode>') || getText.includes('<ErrorMessage>')) {
      const errMatch = getText.match(/<ErrorMessage>(.*?)<\/ErrorMessage>/);
      throw new Error(errMatch ? `IBKR error: ${errMatch[1]}` : 'Unknown IBKR error');
    }

    // Got data
    console.log(`[flex] Report received (${getText.length} chars)`);
    return getText;
  }

  throw new Error('IBKR Flex report timed out after all poll attempts.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
