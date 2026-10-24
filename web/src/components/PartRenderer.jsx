import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { getMdComponents } from '../lib/markdown-components.jsx'
import AskUserQuestionCard from './AskUserQuestionCard.jsx'
import CanUseToolCard from './CanUseToolCard.jsx'
import PlanApprovalCard from './PlanApprovalCard.jsx'
import ReasoningBlock from './ReasoningBlock.jsx'
import PlanningStatus from './PlanningStatus.jsx'
import CompactionRow from './CompactionRow.jsx'
import TodoListCard from './TodoListCard.jsx'

/**
 * Non-tool transcript parts (reasoning, ask, plan, todo, compaction).
 * Tool rows and explore/browser groups are owned by BubbleRow / ToolGroupRow.
 */
export default function PartRenderer({
  part,
  index,
  rowCount,
  messageStreaming,
}) {
  switch (part.type) {
    case 'text': {
      if (!part.content?.trim()) return null
      const partStreaming = messageStreaming && index === rowCount - 1
      const mdComponents = getMdComponents({ streaming: partStreaming })
      return (
        <div className='content'>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {part.content}
          </ReactMarkdown>
        </div>
      )
    }
    case 'reasoning':
      if (
        part.status !== 'streaming' &&
        (!part.content || part.content.trim() === '') &&
        (!part.duration || part.duration <= 2)
      )
        return null
      return <ReasoningBlock part={part} />
    case 'thinking':
      return <PlanningStatus />
    case 'ask_user_question':
      return <AskUserQuestionCard part={part} />
    case 'can_use_tool':
      return <CanUseToolCard part={part} />
    case 'plan_approval':
      return <PlanApprovalCard part={part} />
    case 'todo_list':
      return <TodoListCard part={part} />
    case 'compaction_start':
      return <CompactionRow state='running' />
    case 'compaction_done':
      return (
        <CompactionRow state={part.status === 'error' ? 'error' : 'done'} />
      )
    case 'error':
      return <p className='error-text'>Error: {part.message}</p>
    default:
      return null
  }
}
