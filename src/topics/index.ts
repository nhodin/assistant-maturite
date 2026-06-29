/**
 * Topic registry — exports all registered topic modules and a flat list of controls.
 */
import type { Control, TopicModule } from "../core"
import { imagesTopic } from "./images"
import { cdnTopic } from "./cdn"

export { imagesTopic } from "./images"
export { cdnTopic } from "./cdn"
export { cacheControlMaxAge } from "./cdn"

export const TOPICS: TopicModule[] = [imagesTopic, cdnTopic]

export const ALL_CONTROLS: Control[] = TOPICS.flatMap((t) => t.controls)
