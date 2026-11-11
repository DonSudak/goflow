import type {ChoiceNode, NarrativeNode} from '@types-folder/nodes';

/** Node types that carry variable operations (narrative: after the line, choice: when picked). */
export type NodeWithOperations = NarrativeNode | ChoiceNode;

export const supportsOperations = (node: {type?: string} | null | undefined): node is NodeWithOperations => node?.type === 'narrative' || node?.type === 'choice';
