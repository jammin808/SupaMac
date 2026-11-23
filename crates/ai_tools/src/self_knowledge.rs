use ai_toolset::{AsyncTool, RequestContext, ServiceContext, ToolResult};
use ai_toolset::{ToolAnnotated, ToolAnnotations};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ToolServiceContext;

#[cfg(test)]
mod test;

/// The "about Macro" page returned by [`SelfKnowledge`].
///
/// Rather than baking a large product description into the system prompt, the
/// model calls this tool to pull in an overview. The page is self-contained: it
/// links no documentation site, so nothing it says sends the model or the user
/// off this deployment.
static ABOUT_MACRO: &str = r##"# About Macro

Macro is a single, fast workspace that unifies the tools a team uses to get work
done — email, messaging, tasks, documents, and more — into one linked database.
Everything can reference everything else: a task can link to an email, a doc can
@mention a channel message, and so on. The backend is Rust and the frontend is
Solid, so it is built for speed.

## What's in Macro

Macro is organized into "blocks":

- **Email** — email, integrated directly into the workspace.
- **Channels** — Slack-like messaging channels; the default way people communicate.
- **Tasks** — task and project tracking.
- **Docs** — collaborative documents.
- **Canvas** — a freeform visual canvas.
- **Calls** — calls and call records.
- **CRM** — customer relationship management.
- **Folders** — file storage.
- **Agents** — AI conversations and coding sessions that can act across the workspace. Read conversations with ReadAgentSession.

Cross-cutting concepts: the **Unified Inbox** (recent items across every block,
read via the ListEntities tool), **Unified Search**, **Unified Memory**,
bidirectional **@mentions / linking**, and **permissions** that inherit from
channels.

## Answering questions about Macro

1. **Answer from this page.** It is the product overview this deployment
   provides. Your training data may be outdated or wrong about Macro, so prefer
   this page over memory.
2. **Look at the workspace itself.** When the question is about the user's own
   items, people or settings, read them with the workspace tools instead of
   describing what might be there.
3. **Say what you don't know.** If neither this page nor the workspace answers
   the question, say so plainly and suggest the user ask whoever runs their
   workspace. Do not search the web for Macro's documentation or send the user
   to it: public pages describe other deployments, whose features, settings and
   addresses need not match this one."##;

/// `selfKnowledge` returns an overview of Macro. It takes no arguments and does
/// no I/O — it hands the model a curated about-page so it can answer "what is
/// Macro / how do I…" questions accurately instead of guessing from stale
/// training data.
#[derive(Debug, Deserialize, JsonSchema, Clone, Default)]
#[schemars(
    title = "SelfKnowledge",
    description = "\
Learn what Macro is and how it works. Call this whenever the user asks an open-ended \
question about Macro itself — what it is, what it's for, what it can do, or how to do \
something in Macro — instead of answering from memory (your training data may be stale). \
Takes no arguments. Returns an overview of Macro's blocks and how they link, and how to \
answer questions the overview does not cover."
)]
pub struct SelfKnowledge {}

/// The response for the [`SelfKnowledge`] tool: a single Markdown about-page.
#[derive(Debug, Serialize, JsonSchema)]
pub struct SelfKnowledgeResponse {
    /// An overview of Macro and how to answer questions about it.
    pub about: String,
}

impl ToolAnnotated for SelfKnowledge {
    const ANNOTATIONS: ToolAnnotations = ToolAnnotations::read_only("About Macro");
}

#[async_trait]
impl AsyncTool<ToolServiceContext> for SelfKnowledge {
    type Output = SelfKnowledgeResponse;

    #[tracing::instrument(skip_all, err)]
    async fn call(
        &self,
        _service_context: ServiceContext<ToolServiceContext>,
        _request_context: RequestContext,
    ) -> ToolResult<Self::Output> {
        Ok(SelfKnowledgeResponse {
            about: ABOUT_MACRO.to_string(),
        })
    }
}
