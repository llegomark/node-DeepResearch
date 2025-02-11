import { z, ZodObject } from 'zod';
import { generateObject } from 'ai';
import { getModel, getMaxTokens, SEARCH_PROVIDER, STEP_SLEEP, LLM_PROVIDER } from "./config";
import { readUrl } from "./tools/read";
import { handleGenerateObjectError } from './utils/error-handling';
import fs from 'fs/promises';
import { SafeSearchType, search as duckSearch } from "duck-duck-scrape";
import { braveSearch } from "./tools/brave-search";
import { rewriteQuery } from "./tools/query-rewriter";
import { dedupQueries } from "./tools/jina-dedup";
import { evaluateAnswer, evaluateQuestion } from "./tools/evaluator";
import { analyzeSteps } from "./tools/error-analyzer";
import { TokenTracker } from "./utils/token-tracker";
import { ActionTracker } from "./utils/action-tracker";
import { StepAction, AnswerAction } from "./types";
import { TrackerContext } from "./types";
import { search } from "./tools/jina-search";
import { grounding } from "./tools/grounding";
import { zodToJsonSchema } from "zod-to-json-schema";

async function sleep(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  console.log(`Waiting ${seconds}s...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSchema(allowReflect: boolean, allowRead: boolean, allowAnswer: boolean, allowSearch: boolean) {
  const actions: string[] = [];
  const properties: Record<string, z.ZodTypeAny> = {
    action: z.enum(['placeholder']), // Will update later with actual actions
    think: z.string().describe("Explain why choose this action, what's the thought process behind choosing this action")
  };

  if (allowSearch) {
    actions.push("search");
    properties.searchQuery = z.string().max(30)
      .describe("Only required when choosing 'search' action, must be a short, keyword-based query that BM25, tf-idf based search engines can understand. Existing queries must be avoided").optional();
  }

  if (allowAnswer) {
    actions.push("answer");
    properties.answer = z.string()
      .describe("Only required when choosing 'answer' action, must be the final answer in natural language").optional();
    properties.references = z.array(
      z.object({
        exactQuote: z.string().describe("Exact relevant quote from the document"),
        url: z.string().describe("source URL; must be directly from the context")
      }).required()
    ).describe("Must be an array of references that support the answer, each reference must contain an exact quote and the URL of the document").optional();
  }

  if (allowReflect) {
    actions.push("reflect");
    properties.questionsToAnswer = z.array(
      z.string().describe("each question must be a single line, concise and clear. not composite or compound, less than 20 words.")
    ).max(2)
      .describe("List of most important questions to fill the knowledge gaps of finding the answer to the original question").optional();
  }

  if (allowRead) {
    actions.push("visit");
    properties.URLTargets = z.array(z.string())
      .max(2)
      .describe("Must be an array of URLs, choose up the most relevant 2 URLs to visit").optional();
  }

  // Update the enum values after collecting all actions
  properties.action = z.enum(actions as [string, ...string[]])
    .describe("Must match exactly one action type");

  return z.object(properties);
}

function getPrompt(
  question: string,
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  badContext?: { question: string, answer: string, evaluation: string, recap: string; blame: string; improvement: string; }[],
  knowledge?: { question: string; answer: string; references?: any[] }[],
  allURLs?: Record<string, string>,
  beastMode?: boolean
): string {
  const sections: string[] = [];
  const actionSections: string[] = [];

  // Add header section
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research analyst specializing in multi-step reasoning. Using your training data and prior lessons learned, answer the following question with absolute certainty:

<question>
${question}
</question>
`);

  // Add context section if exists
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join('\n')}

</context>
`);
  }

  // Add knowledge section if exists
  if (knowledge?.length) {
    const knowledgeItems = knowledge
      .map((k, i) => `
<knowledge-${i + 1}>
<question>
${k.question}
</question>
<answer>
${k.answer}
</answer>
${k.references ? `
<references>
${JSON.stringify(k.references)}
</references>
` : ''}
</knowledge-${i + 1}>
`)
      .join('\n\n');

    sections.push(`
You have successfully gathered some knowledge which might be useful for answering the original question. Here is the knowledge you have gathered so far:
<knowledge>

${knowledgeItems}

</knowledge>
`);
  }

  // Add bad context section if exists
  if (badContext?.length) {
    const attempts = badContext
      .map((c, i) => `
<attempt-${i + 1}>
- Question: ${c.question}
- Answer: ${c.answer}
- Reject Reason: ${c.evaluation}
- Actions Recap: ${c.recap}
- Actions Blame: ${c.blame}
</attempt-${i + 1}>
`)
      .join('\n\n');

    const learnedStrategy = badContext.map(c => c.improvement).join('\n');

    sections.push(`
Your have tried the following actions but failed to find the answer to the question:
<bad-attempts>    

${attempts}

</bad-attempts>

Based on the failed attempts, you have learned the following strategy:
<learned-strategy>
${learnedStrategy}
</learned-strategy>
`);
  }

  // Build actions section
  if (allURLs && Object.keys(allURLs).length > 0 && allowRead) {
    const urlList = Object.entries(allURLs)
      .map(([url, desc]) => `  + "${url}": "${desc}"`)
      .join('\n');

    actionSections.push(`
<action-visit>    
- Visit any URLs from below to gather external knowledge, choose the most relevant URLs that might contain the answer
<url-list>
${urlList}
</url-list>
- When you have enough search result in the context and want to deep dive into specific URLs
- It allows you to access the full content behind any URLs

</action-visit>
`);
  }

  if (allowSearch) {
    actionSections.push(`
<action-search>    
${allKeywords?.length ? `
- Avoid the searched queries below as they do not give any useful information, you need to think out of the box and propose queries from a completely different angle:
<bad-queries>
${allKeywords.join('\n')}
</bad-queries>
`.trim() : ''}
- Propose some unique new queries that might help you find the answer to the question
- Focus on solving one specific aspect of the original question
- Only use keywords, not full sentences
</action-search>
`);
  }

  if (allowAnswer) {
    actionSections.push(`
<action-answer>
- If <question> is a simple greeting, chit-chat, or general knowledge, provide the answer directly.
- Provide final response only when 100% certain
- Responses must be definitive (no ambiguity, uncertainty, or disclaimers)${allowReflect ? '\n- If doubts remain, use <action-reflect> instead' : ''}
</action-answer>
`);
  }

  if (beastMode) {
    actionSections.push(`
<action-answer>
- Any answer is better than no answer
- Partial answers are allowed, but make sure they are based on the context and knowledge you have gathered    
- When uncertain, educated guess based on the context and knowledge is allowed and encouraged.
- Responses must be definitive (no ambiguity, uncertainty, or disclaimers)
</action-answer>
`);
  }

  if (allowReflect) {
    actionSections.push(`
<action-reflect>    
- Perform critical analysis through hypothetical scenarios or systematic breakdowns
- Identify knowledge gaps and formulate essential clarifying questions
- Questions must be:
  - Original (not variations of existing questions)
  - Focused on single concepts
  - Under 20 words
  - Non-compound/non-complex
</action-reflect>
`);
  }

  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join('\n\n')}
</actions>
`);

  // Add footer
  sections.push(`Respond exclusively in valid JSON format matching exact JSON schema.

Critical Requirements:
- Include ONLY ONE action type
- Never add unsupported keys
- Exclude all non-JSON text, markdown, or explanations
- Maintain strict JSON syntax`);

  return removeExtraLineBreaks(sections.join('\n\n'));
}

const removeExtraLineBreaks = (text: string) => {
  return text.replace(/\n{2,}/gm, '\n\n');
}

const allContext: StepAction[] = [];  // all steps in the current session, including those leads to wrong results

function updateContext(step: any) {
  allContext.push(step)
}

function removeAllLineBreaks(text: string) {
  return text.replace(/(\r\n|\n|\r)/gm, " ");
}

function removeHTMLtags(text: string) {
  return text.replace(/<[^>]*>?/gm, '');
}

export async function getResponse(question: string, tokenBudget: number = 1_000_000,
  maxBadAttempts: number = 3,
  existingContext?: Partial<TrackerContext>): Promise<{ result: StepAction; context: TrackerContext }> {
  const context: TrackerContext = {
    tokenTracker: existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker()
  };
  let step = 0;
  let totalStep = 0;
  let badAttempts = 0;
  let schema: ZodObject<any> = getSchema(true, true, true, true)
  const gaps: string[] = [question];  // All questions to be answered including the orginal question
  const allQuestions = [question];
  const allKeywords = [];
  const allKnowledge = [];  // knowledge are intermedidate questions that are answered
  const badContext = [];
  let diaryContext = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let prompt = '';
  let thisStep: StepAction = { action: 'answer', answer: '', references: [], think: '' };
  let isAnswered = false;

  const allURLs: Record<string, string> = {};
  const visitedURLs: string[] = [];
  const evaluationMetrics: Record<string, any[]> = {};
  while (context.tokenTracker.getTotalUsage() < tokenBudget && badAttempts <= maxBadAttempts) {
    // add 1s delay to avoid rate limiting
    await sleep(STEP_SLEEP);
    step++;
    totalStep++;
    const budgetPercentage = (context.tokenTracker.getTotalUsage() / tokenBudget * 100).toFixed(2);
    console.log(`Step ${totalStep} / Budget used ${budgetPercentage}%`);
    console.log('Gaps:', gaps);
    allowReflect = allowReflect && (gaps.length <= 1);
    const currentQuestion = gaps.length > 0 ? gaps.shift()! : question;
    if (!evaluationMetrics[currentQuestion]) {
      evaluationMetrics[currentQuestion] = await evaluateQuestion(currentQuestion, context.tokenTracker)
    }

    // update all urls with buildURLMap
    allowRead = allowRead && (Object.keys(allURLs).length > 0);
    allowSearch = allowSearch && (Object.keys(allURLs).length < 50);  // disable search when too many urls already

    // generate prompt for this step
    prompt = getPrompt(
      currentQuestion,
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      badContext,
      allKnowledge,
      allURLs,
      false
    );
    schema = getSchema(allowReflect, allowRead, allowAnswer, allowSearch)
    const model = getModel('agent');
    let object;
    let totalTokens = 0;
    try {
      const result = await generateObject({
        model,
        schema,
        prompt,
        maxTokens: getMaxTokens('agent')
      });
      object = result.object;
      totalTokens = result.usage?.totalTokens || 0;
    } catch (error) {
      const result = await handleGenerateObjectError<StepAction>(error);
      object = result.object;
      totalTokens = result.totalTokens;
    }
    thisStep = object as StepAction;
    // print allowed and chose action
    const actionsStr = [allowSearch, allowRead, allowAnswer, allowReflect].map((a, i) => a ? ['search', 'read', 'answer', 'reflect'][i] : null).filter(a => a).join(', ');
    console.log(`${thisStep.action} <- [${actionsStr}]`);
    console.log(thisStep)

    context.actionTracker.trackAction({ totalStep, thisStep, gaps, badAttempts });
    context.tokenTracker.trackUsage('agent', totalTokens);

    // reset allowAnswer to true
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;

    // execute the step and action
    if (thisStep.action === 'answer') {
      if (step === 1) {
        // LLM is so confident and answer immediately, skip all evaluations
        isAnswered = true;
        break
      }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });

      const { response: evaluation } = await evaluateAnswer(currentQuestion, thisStep,
        evaluationMetrics[currentQuestion], context.tokenTracker);

      if (currentQuestion === question) {
        if (evaluation.pass) {
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          isAnswered = true;
          break
        } else {
          if (badAttempts >= maxBadAttempts) {
            isAnswered = false;
            break
          } else {
            diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is bad because: 
${evaluation.think}
`);
            // store the bad context and reset the diary context
            const { response: errorAnalysis } = await analyzeSteps(diaryContext);

            allKnowledge.push({
              question: currentQuestion,
              answer: thisStep.answer,
              references: thisStep.references,
              type: 'qa'
            });

            badContext.push({
              question: currentQuestion,
              answer: thisStep.answer,
              evaluation: evaluation.think,
              ...errorAnalysis
            });

            if (errorAnalysis.questionsToAnswer) {
              gaps.push(...errorAnalysis.questionsToAnswer.slice(0, 2));
              allQuestions.push(...errorAnalysis.questionsToAnswer.slice(0, 2));
              gaps.push(question);  // always keep the original question in the gaps
            }

            badAttempts++;
            allowAnswer = false;  // disable answer action in the immediate next step
            diaryContext = [];
            step = 0;
          }
        }
      } else if (evaluation.pass) {
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          references: thisStep.references,
          type: 'qa'
        });
      }
    } else if (thisStep.action === 'reflect' && thisStep.questionsToAnswer) {
      let newGapQuestions = thisStep.questionsToAnswer
      const oldQuestions = newGapQuestions;
      newGapQuestions = (await dedupQueries(newGapQuestions, allQuestions)).unique_queries;
      if (newGapQuestions.length > 0) {
        // found new gap questions
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join('\n')}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        gaps.push(question);  // always keep the original question in the gaps
      } else {
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${oldQuestions.join(', ')} 
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle. 
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!'
        });

        allowReflect = false;
      }
    } else if (thisStep.action === 'search' && thisStep.searchQuery) {
      // rewrite queries
      let { queries: keywordsQueries } = await rewriteQuery(thisStep);

      const oldKeywords = keywordsQueries;
      // avoid existing searched queries
      const { unique_queries: dedupedQueries } = await dedupQueries(keywordsQueries, allKeywords);
      keywordsQueries = dedupedQueries;

      if (keywordsQueries.length > 0) {
        let googleGrounded = '';
        const searchResults = [];
        for (const query of keywordsQueries) {
          console.log(`Search query: ${query}`);

          // Add grounding for each query
          if (LLM_PROVIDER === 'gemini') {
            try {
              googleGrounded = await grounding(query, context.tokenTracker);
            } catch (error) {
              console.error('Grounding failed:', error);
              // Continue with regular search even if grounding fails
            }
          }

          let results;

          switch (SEARCH_PROVIDER) {
            case 'jina':
              // use jinaSearch
              results = { results: (await search(query, context.tokenTracker)).response?.data || [] };
              break;
            case 'duck':
              results = await duckSearch(query, { safeSearch: SafeSearchType.STRICT });
              break;
            case 'brave':
              try {
                const { response } = await braveSearch(query);
                results = {
                  results: response.web?.results?.map(r => ({
                    title: r.title,
                    url: r.url,
                    description: r.description
                  })) || []
                };
              } catch (error) {
                console.error('Brave search failed:', error);
                results = { results: [] };
              }
              await sleep(STEP_SLEEP)
              break;
            default:
              results = { results: [] };
          }
          const minResults = results.results.map(r => ({
            title: r.title,
            url: r.url,
            description: r.description
          }));

          Object.assign(allURLs, Object.fromEntries(
            minResults.map(r => [r.url, r.title])
          ));
          searchResults.push({ query, results: minResults });
          allKeywords.push(query);
        }

        allKnowledge.push({
          question: `What do Internet say about ${thisStep.searchQuery}?`,
          answer: googleGrounded + removeHTMLtags(searchResults.map(r => r.results.map(r => r.description).join('; ')).join('; ')),
          type: 'side-info'
        });

        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries.join(', ')}".
You found quite some information and add them to your URL list and **visit** them later when needed. 
`);

        updateContext({
          totalStep,
          question: currentQuestion,
          ...thisStep,
          result: searchResults
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: ${oldKeywords.join(', ')}. 
But then you realized you have already searched for these keywords before.
You decided to think out of the box or cut from a completely different angle.
`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible queries and found no new information. You must think out of the box or different angle!!!'
        });

        allowSearch = false;
      }
    } else if (thisStep.action === 'visit' && thisStep.URLTargets?.length) {
      let uniqueURLs = thisStep.URLTargets;
      if (visitedURLs.length > 0) {
        // check duplicate urls
        uniqueURLs = uniqueURLs.filter((url: string) => !visitedURLs.includes(url));
      }

      if (uniqueURLs.length > 0) {
        const urlResults = await Promise.all(
          uniqueURLs.map(async (url: string) => {
            try {
              const { response, tokens } = await readUrl(url, context.tokenTracker);
              allKnowledge.push({
                question: `What is in ${response.data?.url || 'the URL'}?`,
                answer: removeAllLineBreaks(response.data?.content || 'No content available'),
                references: [response.data?.url],
                type: 'url'
              });
              visitedURLs.push(url);
              delete allURLs[url];
              return { url, result: response, tokens };
            } catch (error) {
              console.error('Error reading URL:', error);
            }
          })
        );
        diaryContext.push(`
At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map(r => r?.url).join('\n')}
You found some useful information on the web and add them to your knowledge for future reference.
`);
        updateContext({
          totalStep,
          question: currentQuestion,
          ...thisStep,
          result: urlResults
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **visit** action and try to visit the following URLs:
${thisStep.URLTargets.join('\n')}
But then you realized you have already visited these URLs and you already know very well about their contents.

You decided to think out of the box or cut from a completely different angle.`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!'
        });

        allowRead = false;
      }
    }

    await storeContext(prompt, schema, [allContext, allKeywords, allQuestions, allKnowledge], totalStep);
  }

  await storeContext(prompt, schema, [allContext, allKeywords, allQuestions, allKnowledge], totalStep);
  if (isAnswered) {
    return { result: thisStep, context };
  } else {
    console.log('Enter Beast mode!!!')
    // any answer is better than no answer, humanity last resort
    step++;
    totalStep++;
    const prompt = getPrompt(
      question,
      diaryContext,
      allQuestions,
      allKeywords,
      false,
      false,
      false,
      false,
      badContext,
      allKnowledge,
      allURLs,
      true
    );

    schema = getSchema(false, false, true, false);
    const model = getModel('agentBeastMode');
    let object;
    let totalTokens;
    try {
      const result = await generateObject({
        model,
        schema: schema,
        prompt,
        maxTokens: getMaxTokens('agentBeastMode')
      });
      object = result.object;
      totalTokens = result.usage?.totalTokens || 0;
    } catch (error) {
      const result = await handleGenerateObjectError<StepAction>(error);
      object = result.object;
      totalTokens = result.totalTokens;
    }
    await storeContext(prompt, schema, [allContext, allKeywords, allQuestions, allKnowledge], totalStep);
    thisStep = object as StepAction;
    context.actionTracker.trackAction({ totalStep, thisStep, gaps, badAttempts });
    context.tokenTracker.trackUsage('agent', totalTokens);
    console.log(thisStep)
    return { result: thisStep, context };
  }
}

async function storeContext(prompt: string, schema: any, memory: any[][], step: number) {
  try {
    await fs.writeFile(`prompt-${step}.txt`, `
Prompt:
${prompt}

JSONSchema:
${JSON.stringify(zodToJsonSchema(schema), null, 2)}
`);
    const [context, keywords, questions, knowledge] = memory;
    await fs.writeFile('context.json', JSON.stringify(context, null, 2));
    await fs.writeFile('queries.json', JSON.stringify(keywords, null, 2));
    await fs.writeFile('questions.json', JSON.stringify(questions, null, 2));
    await fs.writeFile('knowledge.json', JSON.stringify(knowledge, null, 2));
  } catch (error) {
    console.error('Context storage failed:', error);
  }
}

export async function main() {
  const question = process.argv[2] || "";
  const {
    result: finalStep,
    context: tracker
  } = await getResponse(question) as { result: AnswerAction; context: TrackerContext };

  console.log('Final Answer:', finalStep.answer);

  // Save results to a file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Create a formatted string from the results
  const outputContent = [
    `Research Results (${timestamp})`,
    '='.repeat(50),
    `Question: ${question}`,
    '',
    'Answer:',
    finalStep.answer,
    '',
    'References:',
    ...(finalStep.references?.map(ref =>
      `- ${ref.url}\n  "${ref.exactQuote}"`) || []),
    '',
    'Token Usage:',
    JSON.stringify(tracker.tokenTracker.getUsageBreakdown(), null, 2),
    '',
    `Total Tokens: ${tracker.tokenTracker.getTotalUsage()}`
  ].join('\n');

  // Write to file
  await fs.writeFile(
    `research-results-${timestamp}.txt`,
    outputContent
  );

  console.log(`\nResults saved to research-results-${timestamp}.txt`);
  tracker.tokenTracker.printSummary();
}

if (require.main === module) {
  main().catch(console.error);
}