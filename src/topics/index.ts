/**
 * Topic registry — exports all registered topic modules and a flat list of controls.
 * Ordered by topic id (1..12). Topics 11 (GEO) and 12 (China) are standalone.
 */
import type { Control, TopicModule } from "../core"
import { imagesTopic } from "./images"
import { sliderTopic } from "./slider"
import { videoTopic } from "./video"
import { thirdPartiesTopic } from "./thirdparties"
import { ttfbCacheTopic } from "./ttfbcache"
import { jsTopic } from "./js"
import { cssTopic } from "./css"
import { criticalPathTopic } from "./criticalpath"
import { fontsTopic } from "./fonts"
import { cdnTopic } from "./cdn"
import { geoTopic } from "./geo"
import { chinaTopic } from "./china"

export {
  imagesTopic,
  sliderTopic,
  videoTopic,
  thirdPartiesTopic,
  ttfbCacheTopic,
  jsTopic,
  cssTopic,
  criticalPathTopic,
  fontsTopic,
  cdnTopic,
  geoTopic,
  chinaTopic,
}
export { cacheControlMaxAge } from "./cdn"

export const TOPICS: TopicModule[] = [
  imagesTopic, // 1
  sliderTopic, // 2
  videoTopic, // 3
  thirdPartiesTopic, // 4
  ttfbCacheTopic, // 5
  jsTopic, // 6
  cssTopic, // 7
  criticalPathTopic, // 8
  fontsTopic, // 9
  cdnTopic, // 10
  geoTopic, // 11
  chinaTopic, // 12
]

export const ALL_CONTROLS: Control[] = TOPICS.flatMap((t) => t.controls)
