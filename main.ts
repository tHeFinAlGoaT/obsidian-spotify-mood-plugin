import { App, Modal, Notice, Plugin, MarkdownView } from "obsidian";
import { shell } from "electron";
import axios from "axios";
const sw = require("stopword");
import aposToLexForm from "apos-to-lex-form";
import natural from "natural";
import { PorterStemmer } from "natural";
import { startWebServer, getAuthorizationCode } from "./webServer";
import moodMap from "moodMap";

const SPOTIFY_CLIENT_ID = "6a78eb4abeb04da89e8389117280e8db";
const SPOTIFY_CLIENT_SECRET = "4519e1aa1f07411d9cfa7b005e3a9b6f";
const SPOTIFY_REDIRECT_URI = "http://localhost:5500/callback";
const SPOTIFY_SCOPES =
	"user-read-email user-read-recently-played user-library-read playlist-read-private playlist-read-collaborative app-remote-control";

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		try {
			await startWebServer();
		} catch (e) {
			console.error(
				"Server already started or port 5500 is in use by another application."
			);
		}

		this.addCommand({
			id: "open-spotify-auth-modal",
			name: "Authenticate with Spotify",
			callback: () => {
				new SpotifyAuthModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "analyze-current-note",
			name: "Analyze Current Note",
			callback: () => {
				this.main();
			},
		});
	}

	onunload() {
		console.log("unloading plugin");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async exchangeCodeForAccessToken(code: string) {
		const tokenEndpoint = "https://accounts.spotify.com/api/token";
		const authHeader = Buffer.from(
			`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
		).toString("base64");

		try {
			const response = await axios.post(
				tokenEndpoint,
				new URLSearchParams({
					grant_type: "authorization_code",
					code: code,
					redirect_uri: SPOTIFY_REDIRECT_URI,
				}),
				{
					headers: {
						Authorization: `Basic ${authHeader}`,
						"Content-Type": "application/x-www-form-urlencoded",
					},
				}
			);

			const accessToken = response.data.access_token;
			console.log(
				"Received access token:",
				accessToken,
				"WARNING: Do not share this token!"
			);

			this.settings.mySetting = accessToken;
			await this.saveSettings();
			new Notice("Successfully saved the access token.");
		} catch (error) {
			console.error("Error exchanging code for access token:", error);
			new Notice("Failed to obtain the access token.");
		}
	}

	async analyzeCurrentNote() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			console.error("No active view of type MarkdownView.");
			return;
		}

		const activeFile = activeView.file;
		if (!activeFile) {
			console.error("No active file.");
			return;
		}

		try {
			const fileContents = await this.app.vault.read(activeFile);

			//preprocessing
			const lexedReview = aposToLexForm(fileContents);
			const casedReview = lexedReview?.toLowerCase() ?? "";
			const alphaOnlyReview = casedReview.replace(/[^a-zA-Z\s]+/g, "");

			const tokenizer = new natural.WordTokenizer();
			const tokenizedReview = tokenizer.tokenize(alphaOnlyReview);

			if (!tokenizedReview || tokenizedReview.length === 0) {
				console.error("Tokenized review is empty.");
				return;
			}

			const filteredReview = sw.removeStopwords(tokenizedReview);

			const analyzer = new natural.SentimentAnalyzer(
				"English",
				PorterStemmer,
				"afinn"
			);
			const analysis = analyzer.getSentiment(filteredReview);

			return analysis;
		} catch (error) {
			console.error("Error analyzing the current note:", error);
		}
	}

	async analysisToSeedGenre(analysis: number) {
		// Find the mood that matches the analysis value
		const moodEntries = Object.entries(moodMap);

		let selectedMood = null;

		for (const [mood, { range_max, range_min }] of moodEntries) {
			if (analysis <= range_max && analysis >= range_min) {
				selectedMood = mood;
				break;
			}
		}

		if (!selectedMood) {
			console.error("No matching mood found for analysis:", analysis);
			return null;
		}

		console.log("Selected Mood:", selectedMood);
		return selectedMood;
	}

	async rpsGetSeedTrack(accessToken: string) {
		//rps: recently played songs
		try {
			const response = await axios.get(
				"https://api.spotify.com/v1/me/player/recently-played",
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				}
			);

			if (!response.data.items || response.data.items.length === 0) {
				console.error("No recently played songs.");
				return null;
			}
			//here we are getting the latest played song's id to use as a seed track
			const seedTrack = response.data.items[0].track.id;
			return seedTrack;
		} catch (error) {
			console.error("Error fetching recently played tracks:", error);
			return null;
		}
	}

	async getReccomendedSongs(
		accessToken: string,
		analysis: number,
		seedTrack: any,
		seedGenre: any
	) {
		try {
			const response = await axios.get(
				"https://api.spotify.com/v1/recommendations",
				{
					params: {
						seed_tracks: seedTrack,
						seed_genres: seedGenre,
						target_valence: analysis,
					},
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				}
			);

			const recommendedSongs = response.data.tracks;
			return recommendedSongs;
		} catch (error) {
			console.error("Error fetching recommended songs:", error);
			return null;
		}
	}

	async main() {
		const analysis = await this.analyzeCurrentNote();
		console.log(analysis);

		const accessToken = this.settings.mySetting;

		// Check if feeling is undefined and provide a default value
		const defaultAnalysis: number = 0; // Replace this with an appropriate default value
		const targetAnalysis =
			analysis !== undefined ? analysis : defaultAnalysis;

		const seedTrack = await this.rpsGetSeedTrack(accessToken);
		console.log(seedTrack);
		const seedGenre = await this.analysisToSeedGenre(targetAnalysis);

		const recommendedSongs = await this.getReccomendedSongs(
			accessToken,
			targetAnalysis,
			seedTrack,
			seedGenre
		);
		console.log(recommendedSongs);
	}
}

class SpotifyAuthModal extends Modal {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Authenticate with Spotify" });
		const authorizeButton = contentEl.createEl("button", {
			text: "Authorize",
			cls: "spotify-authorize-button",
		});
		authorizeButton.addEventListener("click", async () => {
			await this.handleAuthorization();
		});
	}

	async handleAuthorization() {
		const authorizeUrl = this.constructAuthorizeURL();
		try {
			await shell.openExternal(authorizeUrl);
		} catch (e) {
			console.error("Error opening Spotify Authorization URL:", e);
			new Notice(
				"Failed to open Spotify authorization page. Please check your internet connection."
			);
		}

		const code = await getAuthorizationCode(); // Fetch the authorization code from the web server

		if (code) {
			await this.plugin.exchangeCodeForAccessToken(code);
		}

		this.close();
	}

	constructAuthorizeURL() {
		return `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${SPOTIFY_REDIRECT_URI}&scope=${SPOTIFY_SCOPES}&show_dialog=true`;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
