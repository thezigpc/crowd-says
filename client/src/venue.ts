// Bar Games venue context and the game's name. Off a box the venue stays null and nothing
// changes: watchVenue() never fires standalone and applyTheme() ignores standalone.

import { useGameName as kitUseGameName, useVenue as kitUseVenue } from "@bargames/gamekit/client";
import type { VenueContext } from "@bargames/sdk/client";
import { DEFAULT_GAME_NAME } from "@crowdsays/shared";
import { serverUrl } from "./socket";

export const useVenue = (): VenueContext | null => kitUseVenue(serverUrl || undefined);

/** GAME_NAME on the server, or the venue's rename on a box. Sets document.title. */
export const useGameName = (): string => kitUseGameName(serverUrl, DEFAULT_GAME_NAME);
