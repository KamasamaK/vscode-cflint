import * as vscode from "vscode";

export interface CFMLApiV0 {
    getContextUtils(): ContextUtilApi;
    componentPathToUri(dotPath: string, baseUri: vscode.Uri): vscode.Uri | undefined;
    isSubcomponent(checkComponent: Component, baseComponent: Component): boolean;
    getComponent(uri: vscode.Uri): Component;
    getScriptFunctionArgRanges(documentStateContext: DocumentStateContext, argsRange: vscode.Range, separatorChar?: string): vscode.Range[];
    isBulkCaching(): boolean;
}

export interface ContextUtilApi {
    isCfmFile(document: vscode.TextDocument): boolean;
    isCfcFile(document: vscode.TextDocument): boolean;
    isCfcUri(uri: vscode.Uri): boolean;
    isPositionScript(document: vscode.TextDocument, position: vscode.Position): boolean;
    isInComment(document: vscode.TextDocument, position: vscode.Position, isScript?: boolean): boolean;
    isStringDelimiter(char: string): boolean;
    getNextCharacterPosition(documentStateContext: DocumentStateContext, startOffset: number, endOffset: number, char: string | string[], includeChar?: boolean): vscode.Position;
    getClosingPosition(documentStateContext: DocumentStateContext, initialOffset: number, closingChar: string): vscode.Position;
}

export interface Component {
    uri: vscode.Uri;
    name: string;
    isScript: boolean;
    isInterface: boolean; // should be a separate type, but chose this for the purpose of simplification
    declarationRange: vscode.Range;
    displayname: string;
    hint: string;
    accessors: boolean;
    initmethod?: string;
    extends?: vscode.Uri;
    extendsRange?: vscode.Range;
    implements?: vscode.Uri[];
    implementsRanges?: vscode.Range[];
    functions: ComponentFunctions;
    properties: Properties;
    variables: Variable[];
    imports: string[];
}

export interface DocumentStateContext {
    document: vscode.TextDocument;
    isCfmFile: boolean;
    isCfcFile: boolean;
    docIsScript: boolean;
    commentRanges: vscode.Range[];
    stringRanges?: vscode.Range[];
    stringEmbeddedCfmlRanges?: vscode.Range[];
    sanitizedDocumentText: string;
    component?: Component;
    userEngine: object; // CFMLEngine
}

export interface Variable {
    identifier: string;
    dataType: DataType;
    dataTypeComponentUri?: vscode.Uri; // Only when dataType is Component
    scope: Scope;
    final: boolean;
    declarationLocation: vscode.Location;
    description?: string;
    initialValue?: string;
}

export enum DataType {
    Any = "any",
    Array = "array",
    Binary = "binary",
    Boolean = "boolean",
    Component = "component",
    Date = "date",
    Function = "function",
    GUID = "guid",
    Numeric = "numeric",
    Query = "query",
    String = "string",
    Struct = "struct",
    UUID = "uuid",
    VariableName = "variablename",
    Void = "void",
    XML = "xml"
}

export enum Scope {
    Application = "application",
    Arguments = "arguments",
    Attributes = "attributes",
    Caller = "caller",
    Cffile = "cffile",
    CGI = "cgi",
    Client = "client",
    Cookie = "cookie",
    Flash = "flash",
    Form = "form",
    Local = "local",
    Request = "request",
    Server = "server",
    Session = "session",
    Static = "static", // Lucee-only
    This = "this",
    ThisTag = "thistag",
    Thread = "thread",
    ThreadLocal = "threadlocal", // Not a real prefix
    URL = "url",
    Unknown = "unknown", // Not a real scope. Use as default.
    Variables = "variables"
}

export type Properties = Map<string, Property>

export interface Property {
    name: string;
    dataType: DataType;
    dataTypeComponentUri?: vscode.Uri; // Only when dataType is Component
    description?: string;
    getter?: boolean;
    setter?: boolean;
    nameRange: vscode.Range;
    dataTypeRange?: vscode.Range;
    propertyRange: vscode.Range;
    default?: string;
}

export type ComponentFunctions = Map<string, UserFunction>

export interface UserFunction extends Function {
    access: Access;
    static: boolean;
    abstract: boolean;
    final: boolean;
    returnTypeUri?: vscode.Uri; // Only when returntype is Component
    returnTypeRange?: vscode.Range;
    nameRange: vscode.Range;
    bodyRange?: vscode.Range;
    signatures: UserFunctionSignature[];
    location: vscode.Location;
    isImplicit: boolean;
}

export interface Function {
    name: string;
    description: string;
    returntype: DataType;
    signatures: Signature[];
}

export interface Signature {
    parameters: Parameter[];
    description?: string;
}

export interface Parameter {
    name: string;
    description: string;
    dataType: DataType;
    required: boolean;
    default?: string;
    enumeratedValues?: string[];
}

export interface UserFunctionSignature extends Signature {
    parameters: Argument[];
}

export interface Argument extends Parameter {
    // description is hint
    nameRange: vscode.Range;
    dataTypeRange?: vscode.Range;
    dataTypeComponentUri?: vscode.Uri; // Only when dataType is Component
}

export enum Access {
    Public = "public",
    Private = "private",
    Package = "package",
    Remote = "remote"
}
