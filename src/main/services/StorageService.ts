import { app } from 'electron'
import { writeFile, readFile, access } from 'fs/promises'
import { join } from 'path'

export interface StorageData {
  [key: string]: any
}

export class StorageService {
  private dataPath: string
  private data: StorageData = {}
  private isLoaded: boolean = false

  constructor(fileName: string = 'app-data.json') {
    this.dataPath = join(app.getPath('userData'), fileName)
    this.loadData()
  }

  public get<T>(key: string, defaultValue: T): T {
    return this.data[key] !== undefined ? this.data[key] : defaultValue
  }

  public set(key: string, value: any): void {
    this.data[key] = value
    this.saveData() // Fire and forget - non-blocking
  }

  public delete(key: string): void {
    delete this.data[key]
    this.saveData() // Fire and forget - non-blocking
  }

  public has(key: string): boolean {
    return key in this.data
  }

  public clear(): void {
    this.data = {}
    this.saveData() // Fire and forget - non-blocking
  }

  public getAll(): StorageData {
    return { ...this.data }
  }

  private async loadData(): Promise<void> {
    try {
      await access(this.dataPath)
      const fileContent = await readFile(this.dataPath, 'utf-8')
      this.data = JSON.parse(fileContent)
      this.isLoaded = true
    } catch (error) {
      // File doesn't exist or is unreadable - start with empty data
      this.data = {}
      this.isLoaded = true
    }
  }

  private async saveData(): Promise<void> {
    try {
      await writeFile(this.dataPath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save storage data:', error)
    }
  }
}