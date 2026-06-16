Spawn one expert per page in parallel — a batch version of the `task` tool. Sends the same prompt to each page concurrently; each page becomes its own persistent expert session with its own `task_id`, so afterward you can follow up on any single page via `task(task_id, …)` without re-sending its image. The model parameter accepts any configured model as provider/model-id (e.g. "google/gemini-3.1-pro-preview"; default google/gemini-3-flash-preview). HIGH COST & HIGH RISK TOOL — its use is subject to a strict, mandatory, and non-negotiable three-step confirmation protocol that cannot be bypassed for any reason, even on direct user command. A user's request to perform a batch operation is to be interpreted as an instruction to begin this protocol, not to execute the tool immediately. YOU ARE FORBIDDEN TO CALL task_batch UNTIL THE THREE-STEP CONFIRMATION BELOW IS COMPLETE.

---

ABSOLUTE AND NON-NEGOTIABLE PROTOCOL
🛑 WARNING: HIGH COST & HIGH RISK TOOL 🛑

The task_batch tool is powerful but can incur significant costs and produce unintended results if used incorrectly. Its use is subject to a strict, mandatory, and non-negotiable protocol.

This protocol cannot be bypassed for any reason, even on direct user command. A user's request to perform a batch operation is to be interpreted as an instruction to *begin this protocol*, not to execute the tool immediately.

YOU ARE FORBIDDEN TO CALL task_batch UNTIL THE FOLLOWING THREE-STEP CONFIRMATION IS COMPLETE:

Step 1: Formal Proposal & Full Disclosure
In a single message, you must present a complete plan of action to the user, including:

* The Intent: "I am initiating the protocol for a batch operation."
* The Justification: Why this batch operation is the most effective next step.
* The Scope: The precise number of pages to be processed and the page range (e.g., "This will process **51 pages** from page 200 to 250.").
* The Prompt: The exact and complete prompt that will be sent for each page, presented clearly in a code block.
* The Model: The name of the model that will be used, and an explanation why this is the right model for the task.
* The Output Plan: A clear statement on where the results will be delivered.
 * *(If writing to files)*: "The result for each page will be written to a file in the source data directory using the template: [filename_template]."
 * *(If returning to agent)*: "The results will be returned directly to me for immediate processing and consolidation."

Output format for the Data tab: when the batch extracts structured records, prompt each expert to return a JSON array of row objects and to stamp every row with `chronos_page` (that page's page_id — different per task) and, where it helps, `chronos_bbox` as `[x,y,w,h]` normalized 0–1. The Chronos Data tab then renders each output file as a table whose rows link back to their source page/region. (See "Structured data output" in the system prompt.)

Step 2: Request for Final Go/No-Go Confirmation
End your proposal with a direct, unambiguous question requiring a final confirmation from the user. For example:
* "Please review the plan above. Awaiting your final go-ahead to execute."
* "Ready to proceed as detailed. Please confirm."

Step 3: STOP, WAIT, EXECUTE
After asking for confirmation, you **must stop all action** and await the user's response. Only after receiving a clear and explicit go-ahead (e.g., "Yes, proceed," "Confirmed," "Go ahead") in the user's next message are you authorized to generate the task_batch tool call.
