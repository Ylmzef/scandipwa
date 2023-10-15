import * as fs from 'fs';
import * as path from 'path';

import { ILogger, IUserInteraction, ResourceType } from '../types';
import { ExportData, StylesOption } from '../types/extend-component.types';
import fixESLint from '../util/eslint';
import { createNewFileWithContents } from '../util/file';
import { removeTsAnnotationsFromDefault, replaceTsWithJs } from '../util/js-generation';
import { getModuleInformation } from '../util/module';
import { getDefaultExportCode, getExportPathsFromCode, getNamedExportsNames } from './ast-interactions';
import { ConfigType, setConfig } from './config';
import { getFileListForResource, getRelativeResourceDirectory } from './fs-interactions';
import generateNewFileContents from './js-generation';
import { resolveExtendableResourcePath, resolveTargetResourceDirectory } from './resolve';
import { createStyleFile, selectStylesOption } from './scss-generation';
import validateResourceExistance from './validate-resource-existance';

const { walkDirectoryUp } = require('@tilework/mosaic-dev-utils/get-context');

/**
 * @param resourceType Type of resource to extend
 * @param resourceName Name of resource to extend
 * @param targetModulePath Module to create new resource in
 * @param logger
 * @param userInteraction
 */
const extend = async (
    resourceType: ResourceType,
    resourceName: string,
    targetModulePath: string,
    logger: ILogger,
    userInteraction: IUserInteraction,
    optionalSourceModulePath?: string,
    config?: ConfigType,
    isTypescript = false
): Promise<string[]> => {
    setConfig(config);

    const relativeResourceDirectory = getRelativeResourceDirectory(resourceName, resourceType);

    // Resolve the source resource using the target module as CWD
    const sourceResourcePath = resolveExtendableResourcePath(
        resourceName,
        resourceType,
        optionalSourceModulePath,
        targetModulePath,
    );

    const sourceModulePath = walkDirectoryUp(sourceResourcePath).pathname;

    if (!validateResourceExistance(
        sourceResourcePath,
        sourceModulePath,
        targetModulePath,
        resourceType,
        resourceName,
        logger,
    )) {
        return [];
    }

    const {
        name: sourceModuleName,
        type: sourceModuleType,
        alias: sourceModuleAlias,
    } = getModuleInformation(sourceModulePath);

    const targetResourceDirectory = resolveTargetResourceDirectory(
        relativeResourceDirectory,
        targetModulePath,
        sourceModuleType,
        sourceModuleName,
    );

    const sourceFiles = getFileListForResource(resourceType, resourceName, sourceResourcePath);

    const createdFiles = await sourceFiles.reduce(async (acc: Promise<string[]>, fileName: string): Promise<string[]> => {
        const createdFiles = await acc;

        // Skipping generation of type files for JS
        if (!isTypescript && fileName.includes('.type.ts')) {
            return createdFiles;
        }

        // Query's resource path is the file path
        // For other resources - it is a parent dir
        const sourceFilePath = resourceType === ResourceType.Query
            ? sourceResourcePath
            : path.resolve(sourceResourcePath, fileName);

        const newFilePath = path.resolve(targetResourceDirectory, isTypescript ? fileName : replaceTsWithJs(fileName));

        // Prevent overwriting
        if (fs.existsSync(newFilePath)) {
            logger.warn(`File ${fileName} exists and will not be overwritten`);

            return createdFiles;
        }

        // Parse the code, get exports
        const code = fs.readFileSync(sourceFilePath, 'utf-8');
        const exportsPaths = getExportPathsFromCode(code);
        const namedExportsData = getNamedExportsNames(exportsPaths);

        // No named exports => nothing to extend
        if (!namedExportsData.length) {
            const [, postfix] = fileName.split('.');

            logger.warn(`No named exports were found in ${postfix}, continuing.`);

            return createdFiles;
        }

        // Get default export code
        const defaultExportCodeSource = getDefaultExportCode(exportsPaths, code);

        // Remove `as unknown` conversions if those are present
        const defaultExportCode = !isTypescript && defaultExportCodeSource ?
            removeTsAnnotationsFromDefault(defaultExportCodeSource) :
            defaultExportCodeSource;

        // Choose exports to extend
        const chosenExports = await userInteraction.multiSelect<ExportData>(
            `Choose things to extend in ${fileName}`,
            namedExportsData.map((x) => ({
                displayName: x.name,
                value: x,
            })),
        );

        let stylesOption: StylesOption | null;

        // Handle styles if necessary
        if ([ResourceType.Route, ResourceType.Component].includes(resourceType) && fileName.includes('.component')) {
            stylesOption = await selectStylesOption(userInteraction);

            // If selected option is "keep styles" => skip style creation
            if (stylesOption && stylesOption !== StylesOption.keep) {
                const styleFilePath = createStyleFile(
                    resourceName,
                    targetResourceDirectory,
                    stylesOption,
                    logger,
                );

                createdFiles.push(styleFilePath);
            }
        }

        // Handle not extending anything in the file
        if (!chosenExports || !chosenExports.length) {
            return createdFiles;
        }

        // Generate contents for the new file
        const newFileContents = generateNewFileContents({
            allExports: namedExportsData,
            chosenExports,
            defaultExportCode,
            fileName,
            originalCode: code,
            resourceType,
            resourceName,
            chosenStylesOption: stylesOption!,
            relativeResourceDirectory,
            sourceModuleName,
            sourceModuleType,
            sourceModuleAlias,
            isTypescript
        });

        // Attempt actual file creation
        const fileIsCreated = createNewFileWithContents(newFilePath, newFileContents, logger);

        // If creation successful => add to the created list
        if (fileIsCreated) {
            return createdFiles.concat(newFilePath);
        }

        return createdFiles;
    }, Promise.resolve([]));

    // Prettify!
    fixESLint(createdFiles);

    return createdFiles;
};

export default extend;
