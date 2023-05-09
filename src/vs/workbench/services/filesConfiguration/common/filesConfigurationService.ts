/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Event, Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { RawContextKey, IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IFilesConfiguration, AutoSaveConfiguration, HotExitConfiguration, FILES_READONLY_COMMAND_CONFIG, FILES_READONLY_INCLUDE_CONFIG, FILES_READONLY_EXCLUDE_CONFIG, IFileStatWithMetadata, IGlobPatterns } from 'vs/platform/files/common/files';
import { equals } from 'vs/base/common/objects';
import { URI } from 'vs/base/common/uri';
import { isWeb } from 'vs/base/common/platform';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ResourceGlobMatcher } from 'vs/workbench/common/resources';
import { IdleValue } from 'vs/base/common/async';
import { Schemas } from 'vs/base/common/network';

export const AutoSaveAfterShortDelayContext = new RawContextKey<boolean>('autoSaveAfterShortDelayContext', false, true);

export interface IAutoSaveConfiguration {
	autoSaveDelay?: number;
	autoSaveFocusChange: boolean;
	autoSaveApplicationChange: boolean;
}

export const enum AutoSaveMode {
	OFF,
	AFTER_SHORT_DELAY,
	AFTER_LONG_DELAY,
	ON_FOCUS_CHANGE,
	ON_WINDOW_CHANGE
}

export const IFilesConfigurationService = createDecorator<IFilesConfigurationService>('filesConfigurationService');

export interface IFilesConfigurationService {

	readonly _serviceBrand: undefined;

	//#region Auto Save

	readonly onAutoSaveConfigurationChange: Event<IAutoSaveConfiguration>;

	getAutoSaveConfiguration(): IAutoSaveConfiguration;

	getAutoSaveMode(): AutoSaveMode;

	toggleAutoSave(): Promise<void>;

	//#endregion

	//#region Configured Readonly

	readonly onReadonlyConfigurationChange: Event<void>;

	isReadonly(resource: URI, stat?: IFileStatWithMetadata): boolean;

	updateReadonly(resource: URI, readonly: true | false | 'toggle' | 'clear'): Promise<boolean>;

	//#endregion

	readonly onFilesAssociationChange: Event<void>;

	readonly isHotExitEnabled: boolean;

	readonly hotExitConfiguration: string | undefined;

	preventSaveConflicts(resource: URI, language?: string): boolean;
}

export class FilesConfigurationService extends Disposable implements IFilesConfigurationService {

	declare readonly _serviceBrand: undefined;

	private static DEFAULT_AUTO_SAVE_MODE = isWeb ? AutoSaveConfiguration.AFTER_DELAY : AutoSaveConfiguration.OFF;

	private readonly _onAutoSaveConfigurationChange = this._register(new Emitter<IAutoSaveConfiguration>());
	readonly onAutoSaveConfigurationChange = this._onAutoSaveConfigurationChange.event;

	private readonly _onFilesAssociationChange = this._register(new Emitter<void>());
	readonly onFilesAssociationChange = this._onFilesAssociationChange.event;

	private readonly _onReadonlyConfigurationChange = this._register(new Emitter<void>());
	readonly onReadonlyConfigurationChange = this._onReadonlyConfigurationChange.event;

	private configuredAutoSaveDelay?: number;
	private configuredAutoSaveOnFocusChange: boolean | undefined;
	private configuredAutoSaveOnWindowChange: boolean | undefined;

	private autoSaveAfterShortDelayContext: IContextKey<boolean>;

	private currentFilesAssociationConfig: { [key: string]: string };

	private currentHotExitConfig: string;

	private readonly readonlyIncludeMatcher = this._register(new IdleValue(() => this.createMatcher(FILES_READONLY_INCLUDE_CONFIG)));
	private readonly readonlyExcludeMatcher = this._register(new IdleValue(() => this.createMatcher(FILES_READONLY_EXCLUDE_CONFIG)));
	private configuredReadonlyFromPermissions: boolean | undefined;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService
	) {
		super();

		this.autoSaveAfterShortDelayContext = AutoSaveAfterShortDelayContext.bindTo(contextKeyService);

		const configuration = configurationService.getValue<IFilesConfiguration>();

		this.currentFilesAssociationConfig = configuration?.files?.associations;
		this.currentHotExitConfig = configuration?.files?.hotExit || HotExitConfiguration.ON_EXIT;

		this.onFilesConfigurationChange(configuration);

		this.registerListeners();
	}

	private createMatcher(config: string) {
		const matcher = this._register(new ResourceGlobMatcher(
			resource => this.configurationService.getValue(config, { resource }),
			event => event.affectsConfiguration(config),
			this.contextService,
			this.configurationService
		));

		this._register(matcher.onExpressionChange(() => this._onReadonlyConfigurationChange.fire()));

		return matcher;
	}

	isReadonly(resource: URI, stat?: IFileStatWithMetadata): boolean {
		const configValue = (this.configurationService.inspect<IGlobPatterns | undefined>(FILES_READONLY_COMMAND_CONFIG, { resource }));
		const globPatterns = configValue.user?.value;
		const pathReadonly = globPatterns && globPatterns[this.uriToPath(resource)];

		if (pathReadonly !== undefined) {
			return pathReadonly;             // resource controlled by Command
		}
		if (this.readonlyIncludeMatcher.value.matches(resource)) {
			return !this.readonlyExcludeMatcher.value.matches(resource); // resource controlled by Inc/Exc Globs
		}
		if (this.configuredReadonlyFromPermissions && stat?.locked) {
			return true; // leverage file permissions if configured as such
		}
		return false;
	}

	async updateReadonly(resource: URI, newValue: true | false | 'toggle' | 'clear'): Promise<boolean> {
		if (newValue === 'toggle') {
			newValue = !this.isReadonly(resource);
		}

		// Add to target setting
		const targetSettingToAdd = FILES_READONLY_COMMAND_CONFIG;
		const configurationToAdd = this.configurationService.inspect<IGlobPatterns | undefined>(targetSettingToAdd, { resource });
		const pathUri = this.uriToPath(resource);

		if (newValue === true || newValue === false) {
			await this.configurationService.updateValue(targetSettingToAdd, {
				...configurationToAdd.user?.value,
				[pathUri]: newValue
			}, ConfigurationTarget.USER);
			return this.isReadonly(resource) === newValue;
		}
		// Remove from other setting (newValue === 'clear')
		const targetSettingToRemove = FILES_READONLY_COMMAND_CONFIG;
		const configurationToRemove = this.configurationService.inspect<IGlobPatterns | undefined>(targetSettingToRemove, { resource });
		if (configurationToRemove.user?.value) {
			const configurationClone = { ...configurationToRemove.user.value };
			delete configurationClone[this.uriToPath(resource)];

			await this.configurationService.updateValue(targetSettingToRemove, configurationClone, ConfigurationTarget.USER);
		}
		return true;
	}

	private uriToPath(uri: URI): string {
		if (uri.scheme === Schemas.file) {
			return uri.fsPath;
		}

		return uri.path;
	}

	private registerListeners(): void {

		// Files configuration changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('files')) {
				this.onFilesConfigurationChange(this.configurationService.getValue<IFilesConfiguration>());
			}
		}));
	}

	protected onFilesConfigurationChange(configuration: IFilesConfiguration): void {

		// Auto Save
		const autoSaveMode = configuration?.files?.autoSave || FilesConfigurationService.DEFAULT_AUTO_SAVE_MODE;
		switch (autoSaveMode) {
			case AutoSaveConfiguration.AFTER_DELAY:
				this.configuredAutoSaveDelay = configuration?.files?.autoSaveDelay;
				this.configuredAutoSaveOnFocusChange = false;
				this.configuredAutoSaveOnWindowChange = false;
				break;

			case AutoSaveConfiguration.ON_FOCUS_CHANGE:
				this.configuredAutoSaveDelay = undefined;
				this.configuredAutoSaveOnFocusChange = true;
				this.configuredAutoSaveOnWindowChange = false;
				break;

			case AutoSaveConfiguration.ON_WINDOW_CHANGE:
				this.configuredAutoSaveDelay = undefined;
				this.configuredAutoSaveOnFocusChange = false;
				this.configuredAutoSaveOnWindowChange = true;
				break;

			default:
				this.configuredAutoSaveDelay = undefined;
				this.configuredAutoSaveOnFocusChange = false;
				this.configuredAutoSaveOnWindowChange = false;
				break;
		}

		this.autoSaveAfterShortDelayContext.set(this.getAutoSaveMode() === AutoSaveMode.AFTER_SHORT_DELAY);
		this._onAutoSaveConfigurationChange.fire(this.getAutoSaveConfiguration());

		// Check for change in files associations
		const filesAssociation = configuration?.files?.associations;
		if (!equals(this.currentFilesAssociationConfig, filesAssociation)) {
			this.currentFilesAssociationConfig = filesAssociation;
			this._onFilesAssociationChange.fire();
		}

		// Hot exit
		const hotExitMode = configuration?.files?.hotExit;
		if (hotExitMode === HotExitConfiguration.OFF || hotExitMode === HotExitConfiguration.ON_EXIT_AND_WINDOW_CLOSE) {
			this.currentHotExitConfig = hotExitMode;
		} else {
			this.currentHotExitConfig = HotExitConfiguration.ON_EXIT;
		}

		// Readonly
		const readonlyFromPermissions = Boolean(configuration?.files?.readonlyFromPermissions);
		if (readonlyFromPermissions !== Boolean(this.configuredReadonlyFromPermissions)) {
			this.configuredReadonlyFromPermissions = readonlyFromPermissions;
			this._onReadonlyConfigurationChange.fire();
		}
	}

	getAutoSaveMode(): AutoSaveMode {
		if (this.configuredAutoSaveOnFocusChange) {
			return AutoSaveMode.ON_FOCUS_CHANGE;
		}

		if (this.configuredAutoSaveOnWindowChange) {
			return AutoSaveMode.ON_WINDOW_CHANGE;
		}

		if (typeof this.configuredAutoSaveDelay === 'number' && this.configuredAutoSaveDelay >= 0) {
			return this.configuredAutoSaveDelay <= 1000 ? AutoSaveMode.AFTER_SHORT_DELAY : AutoSaveMode.AFTER_LONG_DELAY;
		}

		return AutoSaveMode.OFF;
	}

	getAutoSaveConfiguration(): IAutoSaveConfiguration {
		return {
			autoSaveDelay: typeof this.configuredAutoSaveDelay === 'number' && this.configuredAutoSaveDelay >= 0 ? this.configuredAutoSaveDelay : undefined,
			autoSaveFocusChange: !!this.configuredAutoSaveOnFocusChange,
			autoSaveApplicationChange: !!this.configuredAutoSaveOnWindowChange
		};
	}

	async toggleAutoSave(): Promise<void> {
		const currentSetting = this.configurationService.getValue('files.autoSave');

		let newAutoSaveValue: string;
		if ([AutoSaveConfiguration.AFTER_DELAY, AutoSaveConfiguration.ON_FOCUS_CHANGE, AutoSaveConfiguration.ON_WINDOW_CHANGE].some(setting => setting === currentSetting)) {
			newAutoSaveValue = AutoSaveConfiguration.OFF;
		} else {
			newAutoSaveValue = AutoSaveConfiguration.AFTER_DELAY;
		}

		return this.configurationService.updateValue('files.autoSave', newAutoSaveValue);
	}

	get isHotExitEnabled(): boolean {
		if (this.contextService.getWorkspace().transient) {
			// Transient workspace: hot exit is disabled because
			// transient workspaces are not restored upon restart
			return false;
		}

		return this.currentHotExitConfig !== HotExitConfiguration.OFF;
	}

	get hotExitConfiguration(): string {
		return this.currentHotExitConfig;
	}

	preventSaveConflicts(resource: URI, language?: string): boolean {
		return this.configurationService.getValue('files.saveConflictResolution', { resource, overrideIdentifier: language }) !== 'overwriteFileOnDisk';
	}
}

registerSingleton(IFilesConfigurationService, FilesConfigurationService, InstantiationType.Eager);
